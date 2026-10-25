from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

if __package__:
    from .common import (
        first_existing_column,
        normalize_station_id,
        read_csv_with_detected_header,
    )
else:
    from common import (
        first_existing_column,
        normalize_station_id,
        read_csv_with_detected_header,
    )

SEASON_MAP = {
    12: "winter",
    1: "winter",
    2: "winter",
    3: "spring",
    4: "spring",
    5: "spring",
    6: "summer",
    7: "summer",
    8: "summer",
    9: "autumn",
    10: "autumn",
    11: "autumn",
}

HOUR_CONVENTION = (
    "Raw HOUR values 01-24 are converted to zero-based timestamps by subtracting "
    "one hour. The source documentation does not verify whether these labels mark "
    "the beginning or end of an interval; this is an explicit working assumption."
)


def parse_datetime(df: pd.DataFrame) -> pd.Series:
    date_col = first_existing_column(
        df.columns, ["date", "measurement date"]
    )
    hour_col = first_existing_column(df.columns, ["hour", "hr"])

    if date_col and hour_col:
        # Source dates use day/month/year, e.g. 31/12/2025.
        date_part = pd.to_datetime(
            df[date_col],
            format="%d/%m/%Y",
            errors="coerce",
        )
        hour = pd.to_numeric(df[hour_col], errors="coerce")

        # The source convention is unresolved, so retain the existing one-hour
        # shift as an explicit assumption rather than presenting it as verified.
        valid_hour = hour.notna() & hour.between(1, 24) & hour.mod(1).eq(0)
        hour = hour.where(valid_hour) - 1

        return date_part + pd.to_timedelta(hour, unit="h")

    dt_col = first_existing_column(
        df.columns, ["datetime", "timestamp", "date/time"]
    )
    if dt_col:
        return pd.to_datetime(df[dt_col], errors="coerce")

    return pd.Series(pd.NaT, index=df.index, dtype="datetime64[ns]")




def load_air_quality_files(repo_root: Path) -> tuple[pd.DataFrame, list[str]]:
    air_dir = repo_root / "Air Quality"
    if not air_dir.exists():
        return pd.DataFrame(), ["Air Quality folder not found"]

    frames: list[pd.DataFrame] = []
    issues: list[str] = []
    for file in sorted(air_dir.glob("*.csv")):
        try:
            df = read_csv_with_detected_header(file)
            df["source_file"] = file.name
            frames.append(df)
        except Exception as exc:
            issues.append(f"Failed to parse {file.name}: {exc}")

    if not frames:
        issues.append("No parsable air-quality CSV files found.")
        return pd.DataFrame(), issues
    return pd.concat(frames, ignore_index=True), issues


def build_outputs(df: pd.DataFrame, out_dir: Path) -> dict:
    analysis_dir = out_dir / "analysis"
    clean_dir = out_dir / "clean"
    analysis_dir.mkdir(parents=True, exist_ok=True)
    clean_dir.mkdir(parents=True, exist_ok=True)

    if df.empty:
        return {"limitations": ["No air-quality data available."]}

    df = df.copy()
    date_col = first_existing_column(df.columns, ["date", "measurement date"])
    hour_col = first_existing_column(df.columns, ["hour", "hr"])
    dt = parse_datetime(df)
    df["datetime"] = dt
    quality = {
        "hour_convention": HOUR_CONVENTION,
        "invalid_timestamps": int(dt.isna().sum()),
        "invalid_hours": 0,
        "duplicate_date_hour_station_keys": 0,
        "missing_station_names": 0,
        "station_normalization_mappings": [],
        "unexpected_pollutant_columns": [],
        "ambiguous_pollutant_columns": {},
        "zero_valid_observation_groups": {
            "daily": 0,
            "monthly": 0,
            "seasonal": 0,
        },
    }
    if hour_col:
        numeric_hour = pd.to_numeric(df[hour_col], errors="coerce")
        quality["invalid_hours"] = int(
            (~(numeric_hour.between(1, 24) & numeric_hour.mod(1).eq(0))).sum()
        )
    if date_col and hour_col:
        key_columns = [date_col, hour_col]
        station_key = first_existing_column(
            df.columns, ["station", "station name", "monitoring station", "site"]
        )
        if station_key:
            key_columns.append(station_key)
            station_values = df[station_key].astype("string")
            quality["missing_station_names"] = int(
                (station_values.isna() | station_values.str.strip().eq("")).sum()
            )
        quality["duplicate_date_hour_station_keys"] = int(
            df.duplicated(key_columns).sum()
        )
    station_col = first_existing_column(df.columns, ["station", "station name", "monitoring station", "site"])
    if station_col:
        df["station_id"] = normalize_station_id(df[station_col])
        mappings = (
            pd.DataFrame({"raw": df[station_col], "normalized": df["station_id"]})
            .drop_duplicates()
            .dropna()
            .sort_values(["raw", "normalized"])
        )
        quality["station_normalization_mappings"] = mappings.to_dict("records")
    else:
        df["station_id"] = pd.NA

    pollutant_map = {
        "NO2": ["no2"],
        "O3": ["o3"],
        "RSP": ["rsp", "pm10"],
        "FSP": ["fsp", "pm2.5", "pm2_5", "pm25"],
    }

    long_records = []
    matched_columns = set()
    for pollutant, keys in pollutant_map.items():
        matching = [c for c in df.columns if any(k in c.lower() for k in keys)]
        matched_columns.update(matching)
        if len(matching) > 1:
            quality["ambiguous_pollutant_columns"][pollutant] = matching
        for col in matching:
            temp = df[["datetime", "station_id", "source_file", col]].copy()
            temp = temp.rename(columns={col: "value"})
            temp["pollutant"] = pollutant
            temp["raw_column"] = col
            long_records.append(temp)

    if not long_records:
        quality["unexpected_pollutant_columns"] = [
            str(c) for c in df.columns if c not in matched_columns
        ]
        return {
            "limitations": ["No expected pollutant columns (NO2/O3/RSP/FSP) found."],
            "data_quality": quality,
        }

    quality["unexpected_pollutant_columns"] = [
        str(c)
        for c in df.columns
        if c not in matched_columns
        and str(c).strip().upper() in {"SO2", "NOX", "CO"}
    ]

    long_df = pd.concat(long_records, ignore_index=True)
    long_df["value"] = pd.to_numeric(long_df["value"], errors="coerce")
    long_df = long_df.dropna(subset=["datetime"]).sort_values("datetime")

    long_df.to_csv(clean_dir / "air_quality_long.csv", index=False)

    # Story 1: Doksuri window
    story1 = long_df[
        (long_df["datetime"] >= pd.Timestamp("2023-07-24"))
        & (long_df["datetime"] < pd.Timestamp("2023-07-30"))
        & (long_df["pollutant"].isin(["NO2", "O3", "RSP", "FSP"]))
    ]
    story1.to_csv(analysis_dir / "story1_doksuri_window.csv", index=False)

    # Story 2: Hourly NO2 patterns
    no2 = long_df[long_df["pollutant"] == "NO2"].copy()
    no2["hour"] = no2["datetime"].dt.hour
    no2["weekday"] = no2["datetime"].dt.day_of_week
    no2["day_type"] = no2["weekday"].map(lambda x: "weekend" if x >= 5 else "weekday")
    story2 = (
        no2.groupby(["station_id", "hour", "day_type"], dropna=False)
        .agg(avg_no2=("value", "mean"), valid_obs=("value", "count"))
        .reset_index()
    )
    story2.to_csv(analysis_dir / "story2_no2_hourly_profiles.csv", index=False)

    # Story 3: seasonal summaries
    base = long_df.copy()
    base["date"] = base["datetime"].dt.date
    base["year"] = base["datetime"].dt.year
    base["month"] = base["datetime"].dt.month
    base["season"] = base["month"].map(SEASON_MAP)

    daily = (
        base.groupby(["date", "station_id", "pollutant"], dropna=False)
        .agg(mean_value=("value", "mean"), valid_obs=("value", "count"))
        .reset_index()
    )
    daily.to_csv(analysis_dir / "story3_daily_summary.csv", index=False)
    quality["zero_valid_observation_groups"]["daily"] = int(
        daily["valid_obs"].eq(0).sum()
    )

    monthly = (
        base.groupby(["year", "month", "station_id", "pollutant"], dropna=False)
        .agg(mean_value=("value", "mean"), valid_obs=("value", "count"))
        .reset_index()
    )
    monthly.to_csv(analysis_dir / "story3_monthly_summary.csv", index=False)
    quality["zero_valid_observation_groups"]["monthly"] = int(
        monthly["valid_obs"].eq(0).sum()
    )

    seasonal = (
        base.groupby(["year", "season", "station_id", "pollutant"], dropna=False)
        .agg(mean_value=("value", "mean"), valid_obs=("value", "count"))
        .reset_index()
    )
    seasonal.to_csv(analysis_dir / "story3_seasonal_summary.csv", index=False)
    quality["zero_valid_observation_groups"]["seasonal"] = int(
        seasonal["valid_obs"].eq(0).sum()
    )

    limitations = []
    if base["station_id"].isna().all():
        limitations.append("No station identifier column detected; station-level comparisons are limited.")
    return {
        "limitations": limitations,
        "data_quality": quality,
        "aggregation": {
            "mean_definition": "Mean of valid hourly observations (observation-weighted).",
            "season_definition": "Calendar-year grouping: December is grouped with January and February of the same year.",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build cleaned and analysis-ready air quality datasets.")
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[1] / "output")
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    df, issues = load_air_quality_files(args.repo_root)
    result = build_outputs(df, args.output_dir)
    result["issues"] = issues

    (args.output_dir / "analysis" / "preprocess_report.json").write_text(
        json.dumps(result, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
