from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

CATEGORY_ORDER = [str(value) for value in range(1, 11)] + ["10+", "missing", "unresolved", "unknown"]
STAR_STATUS_ORDER = ["unstarred", "starred", "none"]
OUTPUT_COLUMNS = [
    "source_month",
    "month_start",
    "station_id",
    "station_raw",
    "station_available",
    "category",
    "star_status",
    "category_count",
    "valid_numeric_observations",
    "high_category_observations",
    "missing_observations",
    "unresolved_observations",
    "unknown_observations",
]
REQUIRED_COLUMNS = {
    "source_file",
    "source_month",
    "source_row_number",
    "date_effective",
    "station_id",
    "station_raw",
    "aqhi_raw",
    "aqhi_class",
    "star_flag",
    "high_category_flag",
    "missing_flag",
    "unresolved_flag",
    "row_type",
    "is_daily_summary",
}
LATE_STATIONS = {"南區", "北區"}


def empty_category_counts() -> pd.DataFrame:
    return pd.DataFrame(columns=OUTPUT_COLUMNS)


def station_is_available(station_raw: str, source_month: str) -> bool:
    """Return source-layout availability for the two stations added in June 2020."""
    return not (station_raw in LATE_STATIONS and source_month < "202006")


def _star_status(row: pd.Series) -> str:
    if bool(row["star_flag"]):
        return "starred"
    if row["aqhi_class"] in {"numeric", "high_category"}:
        return "unstarred"
    return "none"


def _category(row: pd.Series) -> str:
    raw = str(row["aqhi_raw"]).strip()
    aqhi_class = row["aqhi_class"]
    if aqhi_class in {"numeric", "numeric_starred"} and raw.rstrip("*").isdigit():
        return raw.rstrip("*")
    if aqhi_class in {"high_category", "high_category_starred"}:
        return "10+"
    if aqhi_class == "blank":
        return "missing"
    if aqhi_class in {"unresolved_marker", "unresolved_marker_starred"}:
        return "unresolved"
    if aqhi_class == "unknown":
        return "unknown"
    raise ValueError(f"Unsupported AQHI classification: {aqhi_class!r}")


def _validate_daily_summary_input(daily_summary: pd.DataFrame) -> None:
    missing = sorted(REQUIRED_COLUMNS - set(daily_summary.columns))
    if missing:
        raise ValueError(f"Missing required AQHI daily-summary columns: {missing}")
    if not daily_summary.empty:
        invalid_rows = daily_summary[
            (daily_summary["row_type"] != "daily_maximum")
            | (~daily_summary["is_daily_summary"].astype(bool))
        ]
        if not invalid_rows.empty:
            raise ValueError("Input contains non-daily-summary records")
        keys = daily_summary[
            ["source_file", "source_row_number", "station_id"]
        ].astype("string")
        if keys.duplicated().any():
            raise ValueError("Duplicate daily-summary source observations detected")


def build_daily_maximum_category_counts(
    daily_summary: pd.DataFrame,
) -> pd.DataFrame:
    """Aggregate one count per source daily maximum and category/status."""
    _validate_daily_summary_input(daily_summary)
    if daily_summary.empty:
        return empty_category_counts()

    frame = daily_summary.copy()
    frame["source_month"] = frame["source_month"].astype("string")
    frame["station_raw"] = frame["station_raw"].astype("string")
    frame["category"] = frame.apply(_category, axis=1)
    frame["star_status"] = frame.apply(_star_status, axis=1)
    frame["station_available"] = [
        station_is_available(station, month)
        for station, month in zip(frame["station_raw"], frame["source_month"])
    ]
    frame["month_start"] = pd.to_datetime(
        frame["source_month"].astype(str) + "01", format="%Y%m%d", errors="coerce"
    ).dt.strftime("%Y-%m-%d")

    grouped = (
        frame.groupby(
            [
                "source_month",
                "month_start",
                "station_id",
                "station_raw",
                "station_available",
                "category",
                "star_status",
            ],
            dropna=False,
        )
        .size()
        .rename("category_count")
        .reset_index()
    )
    metrics = (
        frame.assign(
            valid_numeric_observation=frame["aqhi_class"].isin(
                {"numeric", "numeric_starred"}
            ),
            high_category_observation=frame["aqhi_class"].isin(
                {"high_category", "high_category_starred"}
            ),
            missing_observation=frame["aqhi_class"].eq("blank"),
            unresolved_observation=frame["aqhi_class"].isin(
                {"unresolved_marker", "unresolved_marker_starred"}
            ),
            unknown_observation=frame["aqhi_class"].eq("unknown"),
        )
        .groupby(
            ["source_month", "station_id", "station_raw"],
            dropna=False,
        )
        .agg(
            valid_numeric_observations=("valid_numeric_observation", "sum"),
            high_category_observations=("high_category_observation", "sum"),
            missing_observations=("missing_observation", "sum"),
            unresolved_observations=("unresolved_observation", "sum"),
            unknown_observations=("unknown_observation", "sum"),
        )
        .reset_index()
    )
    result = grouped.merge(
        metrics, on=["source_month", "station_id", "station_raw"], how="left"
    )
    result["category"] = pd.Categorical(
        result["category"], categories=CATEGORY_ORDER, ordered=True
    )
    result["star_status"] = pd.Categorical(
        result["star_status"], categories=STAR_STATUS_ORDER, ordered=True
    )
    result = result.sort_values(
        ["source_month", "station_raw", "category", "star_status"],
        kind="stable",
    ).reset_index(drop=True)
    return result[OUTPUT_COLUMNS]


def write_daily_maximum_category_counts(
    daily_summary_path: Path,
    output_path: Path,
    *,
    overwrite: bool = False,
) -> pd.DataFrame:
    if output_path.exists() and not overwrite:
        raise FileExistsError(f"Refusing to overwrite existing output: {output_path}")
    daily_summary = pd.read_csv(daily_summary_path, encoding="utf-8-sig")
    result = build_daily_maximum_category_counts(daily_summary)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    result.to_csv(output_path, index=False)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Build AQHI daily maximum category counts.")
    root = Path(__file__).resolve().parents[1]
    parser.add_argument(
        "--input",
        type=Path,
        default=root / "output" / "clean" / "aqhi_daily_summary.csv",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=root / "output" / "analysis" / "aqhi_daily_max_category_counts.csv",
    )
    args = parser.parse_args()
    write_daily_maximum_category_counts(args.input, args.output)


if __name__ == "__main__":
    main()
