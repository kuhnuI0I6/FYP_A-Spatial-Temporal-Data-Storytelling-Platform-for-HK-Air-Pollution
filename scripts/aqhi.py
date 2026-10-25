from __future__ import annotations

import csv
import json
import re
from pathlib import Path
from typing import Any

import pandas as pd

from .common import normalize_station_id

AQHI_HEADER = ("日期", "時間")
DAILY_SUMMARY_LABEL = "每日最高值"
MONTH_PATTERN = re.compile(r"^(?P<year>20\d{2})(?P<month>0[1-9]|1[0-2])$")
MONTH_FILENAME_PATTERN = re.compile(r"(?P<month>20\d{4})")
HOUR_PATTERN = re.compile(r"^(0[1-9]|1[0-9]|2[0-4])$")

HOURLY_COLUMNS = [
    "source_file",
    "source_month",
    "source_row_number",
    "date_raw",
    "date_effective",
    "date_was_inherited",
    "hour_raw",
    "hour_label",
    "station_raw",
    "station_id",
    "aqhi_raw",
    "aqhi_numeric",
    "aqhi_class",
    "star_flag",
    "high_category_flag",
    "missing_flag",
    "unresolved_flag",
    "parse_reason",
    "row_type",
    "is_daily_summary",
]


def extract_month_key(filename: str | Path) -> str:
    match = MONTH_FILENAME_PATTERN.search(Path(filename).name)
    if not match:
        raise ValueError(f"Could not find a YYYYMM month key in {filename}")
    month_key = match.group("month")
    if not MONTH_PATTERN.fullmatch(month_key):
        raise ValueError(f"Invalid month key in {filename}: {month_key}")
    return month_key


def discover_aqhi_files(aqhi_dir: Path) -> tuple[list[Path], dict[str, Any]]:
    files = sorted(aqhi_dir.glob("*_ChT*.csv"))
    by_month: dict[str, list[Path]] = {}
    invalid_files: list[str] = []
    for path in files:
        try:
            month_key = extract_month_key(path.name)
        except ValueError:
            invalid_files.append(path.name)
            continue
        by_month.setdefault(month_key, []).append(path)

    duplicates = {
        month: [path.name for path in paths]
        for month, paths in by_month.items()
        if len(paths) > 1
    }
    ordered = [paths[0] for month, paths in sorted(by_month.items()) if len(paths) == 1]
    report = {
        "files_discovered": len(files),
        "invalid_filenames": invalid_files,
        "duplicate_month_keys": duplicates,
        "month_keys": sorted(by_month),
    }
    return ordered, report


def classify_aqhi_token(raw_value: object) -> dict[str, Any]:
    raw = "" if raw_value is None else str(raw_value)
    token = raw.strip()
    star = token.endswith("*")
    base = token[:-1].strip() if star else token

    result: dict[str, Any] = {
        "aqhi_raw": raw,
        "aqhi_numeric": pd.NA,
        "aqhi_class": "blank",
        "star_flag": star,
        "high_category_flag": False,
        "missing_flag": True,
        "unresolved_flag": False,
        "parse_reason": "blank value",
    }
    if not token:
        return result
    if base in {"10+"}:
        result.update(
            aqhi_class="high_category_starred" if star else "high_category",
            high_category_flag=True,
            parse_reason="AQHI is above category 10; numeric value not assigned",
        )
        return result
    if base.isdigit() and 1 <= int(base) <= 10:
        result.update(
            aqhi_numeric=int(base),
            aqhi_class="numeric_starred" if star else "numeric",
            missing_flag=False,
            parse_reason="numeric AQHI value",
        )
        return result
    if token in {"-", "-*", "*"}:
        result.update(
            aqhi_class="unresolved_marker_starred" if star else "unresolved_marker",
            unresolved_flag=True,
            parse_reason="source marker meaning is not yet verified",
        )
        return result
    result.update(
        aqhi_class="unknown",
        unresolved_flag=True,
        parse_reason="unexpected AQHI token",
    )
    return result


def _parse_date(value: str) -> pd.Timestamp | pd.NaT:
    if not value.strip():
        return pd.NaT
    return pd.to_datetime(value.strip(), errors="coerce")


def _empty_frame(columns: list[str]) -> pd.DataFrame:
    return pd.DataFrame(columns=columns)


def parse_aqhi_file(
    path: Path, *, retain_daily_summaries: bool = True
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    month_key = extract_month_key(path.name)
    report: dict[str, Any] = {
        "source_file": path.name,
        "source_month": month_key,
        "header_row": None,
        "station_count": 0,
        "station_names": [],
        "hourly_rows": 0,
        "daily_summary_rows": 0,
        "hourly_observations": 0,
        "daily_summary_observations": 0,
        "invalid_dates": 0,
        "invalid_hours": 0,
        "duplicate_date_hour_station_keys": 0,
        "parse_errors": [],
        "unexpected_tokens": {},
        "value_counts": {},
    }

    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.reader(handle))
    except (OSError, UnicodeError, csv.Error) as exc:
        report["parse_errors"].append(str(exc))
        return _empty_frame(HOURLY_COLUMNS), _empty_frame(HOURLY_COLUMNS), report

    header_index = next(
        (
            index
            for index, row in enumerate(rows)
            if len(row) >= 2
            and tuple(cell.strip() for cell in row[:2]) == AQHI_HEADER
        ),
        None,
    )
    report["header_row"] = header_index
    if header_index is None:
        report["parse_errors"].append("AQHI header 日期,時間 was not found")
        return _empty_frame(HOURLY_COLUMNS), _empty_frame(HOURLY_COLUMNS), report

    header = [cell.strip() for cell in rows[header_index]]
    stations = header[2:]
    report["station_count"] = len(stations)
    report["station_names"] = stations
    if not stations:
        report["parse_errors"].append("No station columns found")
        return _empty_frame(HOURLY_COLUMNS), _empty_frame(HOURLY_COLUMNS), report

    hourly_records: list[dict[str, Any]] = []
    summary_records: list[dict[str, Any]] = []
    current_date: pd.Timestamp | pd.NaT = pd.NaT
    keys: list[tuple[object, str, str]] = []

    for physical_index, row in enumerate(rows[header_index + 1 :], start=header_index + 2):
        values = row + [""] * max(0, len(header) - len(row))
        date_raw = values[0].strip()
        hour_raw = values[1].strip()
        parsed_date = _parse_date(date_raw)
        if date_raw:
            if pd.isna(parsed_date):
                report["invalid_dates"] += 1
            else:
                current_date = parsed_date
        date_effective = current_date
        date_was_inherited = not date_raw and not pd.isna(date_effective)

        is_summary = hour_raw == DAILY_SUMMARY_LABEL
        if not is_summary and not HOUR_PATTERN.fullmatch(hour_raw):
            if not date_raw and not hour_raw and all(not value.strip() for value in values[2:]):
                continue
            report["invalid_hours"] += 1
            continue
        else:
            row_type = "daily_maximum" if is_summary else "hourly"

        target = summary_records if is_summary else hourly_records
        if is_summary:
            report["daily_summary_rows"] += 1
        elif row_type == "hourly":
            report["hourly_rows"] += 1

        for station_index, station in enumerate(stations, start=2):
            classification = classify_aqhi_token(values[station_index])
            record = {
                "source_file": path.name,
                "source_month": month_key,
                "source_row_number": physical_index,
                "date_raw": date_raw,
                "date_effective": date_effective,
                "date_was_inherited": date_was_inherited,
                "hour_raw": hour_raw,
                "hour_label": hour_raw if row_type == "hourly" else pd.NA,
                "station_raw": station,
                "station_id": normalize_station_id(pd.Series([station])).iloc[0],
                **classification,
                "row_type": row_type,
                "is_daily_summary": is_summary,
            }
            target.append(record)
            report["value_counts"][classification["aqhi_class"]] = (
                report["value_counts"].get(classification["aqhi_class"], 0) + 1
            )
            if classification["aqhi_class"] == "unknown":
                token = classification["aqhi_raw"]
                report["unexpected_tokens"][token] = (
                    report["unexpected_tokens"].get(token, 0) + 1
                )
            if row_type == "hourly":
                keys.append((date_effective, hour_raw, record["station_id"]))

    report["hourly_observations"] = len(hourly_records)
    report["daily_summary_observations"] = len(summary_records)
    report["duplicate_date_hour_station_keys"] = len(keys) - len(set(keys))
    hourly = pd.DataFrame(hourly_records, columns=HOURLY_COLUMNS)
    summaries = pd.DataFrame(summary_records, columns=HOURLY_COLUMNS)
    if not retain_daily_summaries:
        summaries = _empty_frame(HOURLY_COLUMNS)
    return hourly, summaries, report


def load_aqhi_directory(
    aqhi_dir: Path, *, retain_daily_summaries: bool = True
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    files, inventory = discover_aqhi_files(aqhi_dir)
    hourly_frames: list[pd.DataFrame] = []
    summary_frames: list[pd.DataFrame] = []
    file_reports: list[dict[str, Any]] = []
    for path in files:
        hourly, summaries, report = parse_aqhi_file(
            path, retain_daily_summaries=retain_daily_summaries
        )
        hourly_frames.append(hourly)
        summary_frames.append(summaries)
        file_reports.append(report)

    expected_months = {f"{year}{month:02d}" for year in range(2020, 2026) for month in range(1, 13)}
    inventory["missing_month_keys"] = sorted(expected_months - set(inventory["month_keys"]))
    quality = {
        "inventory": inventory,
        "files": file_reports,
        "files_discovered": inventory["files_discovered"],
        "hourly_rows": sum(report["hourly_rows"] for report in file_reports),
        "daily_summary_rows": sum(report["daily_summary_rows"] for report in file_reports),
        "hourly_observations": sum(report["hourly_observations"] for report in file_reports),
        "daily_summary_observations": sum(
            report["daily_summary_observations"] for report in file_reports
        ),
        "value_counts": {},
        "invalid_dates": sum(report["invalid_dates"] for report in file_reports),
        "invalid_hours": sum(report["invalid_hours"] for report in file_reports),
        "duplicate_date_hour_station_keys": sum(
            report["duplicate_date_hour_station_keys"] for report in file_reports
        ),
        "unexpected_tokens": {},
    }
    for report in file_reports:
        for key, count in report["value_counts"].items():
            quality["value_counts"][key] = quality["value_counts"].get(key, 0) + count
        for token, count in report["unexpected_tokens"].items():
            quality["unexpected_tokens"][token] = quality["unexpected_tokens"].get(token, 0) + count

    hourly = (
        pd.concat(hourly_frames, ignore_index=True)
        if hourly_frames
        else _empty_frame(HOURLY_COLUMNS)
    )
    summaries = (
        pd.concat(summary_frames, ignore_index=True)
        if summary_frames
        else _empty_frame(HOURLY_COLUMNS)
    )
    return hourly, summaries, quality


def export_aqhi_outputs(
    aqhi_dir: Path,
    output_dir: Path,
    *,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Export standalone AQHI tables and the loader quality report.

    Existing output files are never replaced unless ``overwrite=True`` is
    explicitly supplied.
    """
    clean_dir = output_dir / "clean"
    analysis_dir = output_dir / "analysis"
    paths = {
        "hourly": clean_dir / "aqhi_hourly.csv",
        "daily_summary": clean_dir / "aqhi_daily_summary.csv",
        "report": analysis_dir / "aqhi_report.json",
    }
    existing = [path for path in paths.values() if path.exists()]
    if existing and not overwrite:
        names = ", ".join(str(path) for path in existing)
        raise FileExistsError(f"Refusing to overwrite existing AQHI outputs: {names}")

    hourly, summaries, quality = load_aqhi_directory(aqhi_dir)
    quality["date_inheritance"] = {
        "hourly_observations_with_inherited_date": int(
            hourly["date_was_inherited"].sum()
        ),
        "hourly_observations_with_explicit_date": int(
            (~hourly["date_was_inherited"]).sum()
        ),
    }
    missingness: list[dict[str, Any]] = []
    if not hourly.empty:
        grouped = hourly.groupby(
            ["source_month", "station_raw"], sort=True, dropna=False
        )
        for (month, station), group in grouped:
            class_counts = group["aqhi_class"].value_counts()
            total = len(group)
            missing_count = int(group["missing_flag"].sum())
            missingness.append(
                {
                    "source_month": str(month),
                    "station_raw": str(station),
                    "total_observations": total,
                    "missing_observations": missing_count,
                    "missing_rate": missing_count / total if total else None,
                    "numeric_observations": int(class_counts.get("numeric", 0)),
                    "numeric_starred_observations": int(
                        class_counts.get("numeric_starred", 0)
                    ),
                    "high_category_observations": int(
                        class_counts.get("high_category", 0)
                        + class_counts.get("high_category_starred", 0)
                    ),
                    "unresolved_observations": int(
                        class_counts.get("unresolved_marker", 0)
                        + class_counts.get("unresolved_marker_starred", 0)
                    ),
                    "unknown_observations": int(class_counts.get("unknown", 0)),
                }
            )
    quality["missingness_by_month_station"] = missingness
    clean_dir.mkdir(parents=True, exist_ok=True)
    analysis_dir.mkdir(parents=True, exist_ok=True)
    hourly.to_csv(paths["hourly"], index=False)
    summaries.to_csv(paths["daily_summary"], index=False)
    with paths["report"].open("w", encoding="utf-8") as handle:
        json.dump(quality, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return {"paths": {key: str(path) for key, path in paths.items()}, "quality": quality}
