from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import pandas as pd

from common import detect_csv_header_row, read_csv_with_detected_header

DATA_DIR_CANDIDATES = [
    "Air Quality",
    "Average relative humidity",
    "average temperature",
    "Average wind direction, average wind ...",
    "Impact of Tropical Cyclones",
    "Total daily rainfall",
    "Traffic flow",
]
DATE_HINTS = ("date", "time", "datetime", "timestamp")
UNIT_HINTS = ("ug/m", "µg/m", "ppb", "ppm", "°c", "mm", "%", "m/s", "km/h")


def inspect_csv(path: Path) -> dict:
    entry = {
        "file": str(path),
        "format": "csv",
        "header_row": None,
        "rows": None,
        "columns": None,
        "column_names": None,
        "date_columns": None,
        "station_columns": None,
        "time_start": None,
        "time_end": None,
        "temporal_resolution_guess": None,
        "missing_cells": None,
        "duplicate_rows": None,
        "unit_tokens": None,
        "limitations": "",
    }
    try:
        header_row = detect_csv_header_row(path)
        df = read_csv_with_detected_header(path)
        entry["header_row"] = header_row
        entry["rows"] = len(df)
        entry["columns"] = len(df.columns)
        entry["column_names"] = "|".join(map(str, df.columns.tolist()))
        lowered = [str(c).lower() for c in df.columns]
        date_cols = [c for c in df.columns if any(h in str(c).lower() for h in DATE_HINTS)]
        station_cols = [c for c in df.columns if any(h in str(c).lower() for h in ("station", "site", "monitor"))]
        entry["date_columns"] = "|".join(map(str, date_cols)) if date_cols else ""
        entry["station_columns"] = "|".join(map(str, station_cols)) if station_cols else ""
        entry["missing_cells"] = int(df.isna().sum().sum())
        entry["duplicate_rows"] = int(df.duplicated().sum())

        unit_tokens = []
        for c in lowered:
            for hint in UNIT_HINTS:
                if hint in c:
                    unit_tokens.append(hint)
        entry["unit_tokens"] = "|".join(sorted(set(unit_tokens)))

        parsed_time = None
        for c in date_cols:
            s = pd.to_datetime(df[c], errors="coerce")
            if s.notna().sum() > 0:
                parsed_time = s
                break

        if parsed_time is not None:
            entry["time_start"] = str(parsed_time.min())
            entry["time_end"] = str(parsed_time.max())
            sorted_vals = parsed_time.dropna().sort_values()
            if len(sorted_vals) > 2:
                deltas = sorted_vals.diff().dropna()
                if len(deltas) > 0:
                    mode_delta = deltas.mode().iloc[0]
                    entry["temporal_resolution_guess"] = str(mode_delta)
        if not date_cols:
            entry["limitations"] = "No obvious date/time column detected; temporal joins may be limited."
    except Exception as exc:
        entry["limitations"] = f"Parsing failed: {exc}"
    return entry


def inspect_file(path: Path) -> dict:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return inspect_csv(path)
    return {
        "file": str(path),
        "format": suffix.lstrip("."),
        "header_row": None,
        "rows": None,
        "columns": None,
        "column_names": None,
        "date_columns": None,
        "station_columns": None,
        "time_start": None,
        "time_end": None,
        "temporal_resolution_guess": None,
        "missing_cells": None,
        "duplicate_rows": None,
        "unit_tokens": None,
        "limitations": "Non-CSV file not profiled in detail by this script.",
    }


def collect_inventory(repo_root: Path, data_dirs: list[str]) -> tuple[pd.DataFrame, list[str]]:
    records: list[dict] = []
    missing_dirs: list[str] = []

    for data_dir in data_dirs:
        abs_dir = repo_root / data_dir
        if not abs_dir.exists():
            missing_dirs.append(data_dir)
            continue
        for path in sorted(p for p in abs_dir.rglob("*") if p.is_file()):
            records.append(inspect_file(path))

    return pd.DataFrame.from_records(records), missing_dirs


def write_markdown_inventory(df: pd.DataFrame, missing_dirs: list[str], out_path: Path) -> None:
    lines = ["# Data Inventory", ""]
    if missing_dirs:
        lines.append("## Missing expected folders")
        for d in missing_dirs:
            lines.append(f"- {d}")
        lines.append("")

    if df.empty:
        lines.append("No data files found in expected folders.")
    else:
        lines.extend(["## File Summary", ""])
        for _, row in df.iterrows():
            lines.append(f"### {Path(row['file']).name}")
            lines.append(f"- Path: `{row['file']}`")
            lines.append(f"- Format: {row['format']}")
            if pd.notna(row.get("rows")):
                lines.append(f"- Rows: {int(row['rows'])}, Columns: {int(row['columns'])}")
            if row.get("column_names"):
                lines.append(f"- Columns: {row['column_names']}")
            if row.get("date_columns"):
                lines.append(f"- Date/Time columns: {row['date_columns']}")
            if row.get("station_columns"):
                lines.append(f"- Station columns: {row['station_columns']}")
            if row.get("time_start") and row.get("time_end"):
                lines.append(f"- Coverage: {row['time_start']} to {row['time_end']}")
            if row.get("temporal_resolution_guess"):
                lines.append(f"- Temporal resolution guess: {row['temporal_resolution_guess']}")
            if pd.notna(row.get("missing_cells")):
                lines.append(f"- Missing cells: {int(row['missing_cells'])}")
            if pd.notna(row.get("duplicate_rows")):
                lines.append(f"- Duplicate rows: {int(row['duplicate_rows'])}")
            if row.get("limitations"):
                lines.append(f"- Limitations: {row['limitations']}")
            lines.append("")

    out_path.write_text("\n".join(lines), encoding="utf-8")


def write_join_guide(df: pd.DataFrame, out_path: Path) -> None:
    joinable = []
    for _, row in df.iterrows():
        join_keys = []
        if row.get("date_columns"):
            join_keys.append("date/time")
        if row.get("station_columns"):
            join_keys.append("station/location")
        if join_keys:
            joinable.append({"file": row["file"], "join_keys": ", ".join(join_keys)})

    guide = {
        "joinable_datasets": joinable,
        "notes": [
            "Only join datasets when timestamp granularity and station/location identifiers align.",
            "Do not force merges for incompatible time intervals; keep separate tables with documented assumptions.",
        ],
    }
    out_path.write_text(json.dumps(guide, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Inspect project datasets and generate inventory reports.")
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[1] / "output")
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "analysis").mkdir(parents=True, exist_ok=True)

    df, missing_dirs = collect_inventory(args.repo_root, DATA_DIR_CANDIDATES)
    csv_out = args.output_dir / "analysis" / "data_inventory.csv"
    md_out = args.output_dir / "analysis" / "data_inventory.md"
    join_out = args.output_dir / "analysis" / "join_compatibility.json"

    df.to_csv(csv_out, index=False)
    write_markdown_inventory(df, missing_dirs, md_out)
    write_join_guide(df, join_out)

    summary = {
        "files_profiled": int(len(df)),
        "missing_expected_folders": missing_dirs,
    }
    (args.output_dir / "analysis" / "inventory_summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
