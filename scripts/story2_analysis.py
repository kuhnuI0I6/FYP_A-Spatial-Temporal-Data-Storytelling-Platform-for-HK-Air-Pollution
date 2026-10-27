"""Story 2 analysis: NO2 hourly profiles on weekdays and weekends.

Descriptive associations only. The outputs do not measure traffic, and they do not
show that any factor causes the NO2 patterns. The EPD hour convention and the HKT
timezone are unverified working assumptions, as recorded in the validation summary.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CLEAN = REPO_ROOT / "output" / "clean" / "air_quality_long.csv"
DEFAULT_EXISTING = REPO_ROOT / "output" / "analysis" / "story2_no2_hourly_profiles.csv"
DEFAULT_OUT_DIR = REPO_ROOT / "output" / "analysis" / "story2"

DAY_TYPES = ("weekday", "weekend")
MIN_COVERAGE = 0.5
MIN_STATIONS = 3
LOW_MEAN_RATIO = 0.5
ASSUMPTIONS = {
    "timezone": "HKT (UTC+8) - unverified working assumption",
    "hour_convention": "hour of day taken from the recorded timestamp - EPD hour convention unverified",
    "day_type": "weekday = Monday to Friday, weekend = Saturday and Sunday (calendar only; public holidays not adjusted)",
    "units": "NO2 values are used as recorded in the source; units not verified for this file",
    "coverage_rule": "a station-hour-day-type cell qualifies if valid days >= 50% of expected days",
    "expected_days_rule": "expected days = calendar weekdays or weekend days from the station's first to last valid NO2 date (inclusive)",
    "missing_values": "missing values are excluded, not treated as zero; zero is a valid value",
}


def expected_days(first: pd.Timestamp, last: pd.Timestamp) -> dict[str, int]:
    """Count calendar weekday and weekend dates in an inclusive date range."""
    days = pd.date_range(first.normalize(), last.normalize(), freq="D")
    weekend = days.day_of_week >= 5
    return {"weekday": int((~weekend).sum()), "weekend": int(weekend.sum())}


def load_no2(path: Path) -> tuple[pd.DataFrame, dict]:
    """Load NO2 rows and drop rows with invalid timestamps, missing stations or missing values."""
    raw = pd.read_csv(
        path,
        usecols=["datetime", "station_id", "pollutant", "value"],
        dtype={"station_id": str, "pollutant": str},
    )
    no2 = raw[raw["pollutant"] == "NO2"]
    dt = pd.to_datetime(no2["datetime"], errors="coerce")
    station = no2["station_id"].where(no2["station_id"].notna() & (no2["station_id"].str.strip() != ""))
    value = pd.to_numeric(no2["value"], errors="coerce")
    stats = {
        "raw_rows_all_pollutants": int(len(raw)),
        "no2_rows": int(len(no2)),
        "invalid_timestamp_rows": int(dt.isna().sum()),
        "missing_station_rows": int(station.isna().sum()),
        "missing_or_nonnumeric_value_rows": int(value.isna().sum()),
    }
    obs = pd.DataFrame({"station_id": station, "dt": dt, "value": value}).dropna()
    stats["usable_rows"] = int(len(obs))
    return obs.reset_index(drop=True), stats


def dedupe_observations(obs: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Keep one value per station and timestamp.

    Exact repeats are collapsed. Keys with conflicting values are dropped entirely,
    because the correct value cannot be chosen from the data.
    """
    keys = ["station_id", "dt"]
    conflict = obs.groupby(keys)["value"].transform("nunique") > 1
    conflicting = obs[conflict]
    kept = obs[~conflict]
    deduped = kept.drop_duplicates(keys)
    stats = {
        "conflicting_keys_dropped": int(conflicting.drop_duplicates(keys).shape[0]),
        "conflicting_rows_dropped": int(conflict.sum()),
        "exact_duplicate_rows_dropped": int(len(kept) - len(deduped)),
        "retained_observations": int(len(deduped)),
    }
    return deduped.reset_index(drop=True), stats


def build_station_hour_profiles(obs: pd.DataFrame) -> pd.DataFrame:
    """One row per station, hour and day type, including cells with no data."""
    d = obs.copy()
    d["date"] = d["dt"].dt.normalize()
    d["hour"] = d["dt"].dt.hour
    d["day_type"] = np.where(d["dt"].dt.day_of_week >= 5, "weekend", "weekday")
    stations = sorted(d["station_id"].unique())

    spans = d.groupby("station_id")["date"].agg(["min", "max"])
    exp = pd.DataFrame([
        {"station_id": s, "day_type": t, "expected_days": expected_days(spans.loc[s, "min"], spans.loc[s, "max"])[t]}
        for s in stations for t in DAY_TYPES
    ])
    grouped = (
        d.groupby(["station_id", "hour", "day_type"])
        .agg(valid_days=("date", "nunique"), valid_obs=("value", "size"), mean_all_valid=("value", "mean"))
        .reset_index()
    )
    grid = pd.DataFrame(
        [(s, h, t) for s in stations for h in range(24) for t in DAY_TYPES],
        columns=["station_id", "hour", "day_type"],
    )
    prof = grid.merge(grouped, on=["station_id", "hour", "day_type"], how="left").merge(
        exp, on=["station_id", "day_type"], how="left"
    )
    prof["valid_days"] = prof["valid_days"].fillna(0).astype(int)
    prof["valid_obs"] = prof["valid_obs"].fillna(0).astype(int)
    prof["coverage_pct"] = prof["valid_days"] / prof["expected_days"]
    prof["qualifies"] = (prof["expected_days"] > 0) & (prof["coverage_pct"] >= MIN_COVERAGE)
    prof["mean_no2"] = prof["mean_all_valid"].where(prof["qualifies"])
    return prof


def build_city_profile(prof: pd.DataFrame) -> pd.DataFrame:
    """Median across qualifying stations for each hour and day type."""
    q = prof[prof["qualifies"]]
    rows = []
    for t in DAY_TYPES:
        for h in range(24):
            vals = q[(q["day_type"] == t) & (q["hour"] == h)]["mean_no2"]
            n = int(len(vals))
            ok = n >= MIN_STATIONS
            rows.append({
                "hour": h,
                "day_type": t,
                "n_stations": n,
                "median_no2": float(vals.median()) if ok else np.nan,
                "p25_no2": float(vals.quantile(0.25)) if ok else np.nan,
                "p75_no2": float(vals.quantile(0.75)) if ok else np.nan,
            })
    return pd.DataFrame(rows)


def build_station_hour_differences(prof: pd.DataFrame) -> pd.DataFrame:
    """Weekday minus weekend mean, for station-hours where both day types qualify."""
    wd = prof[prof["day_type"] == "weekday"][["station_id", "hour", "mean_no2", "qualifies"]]
    we = prof[prof["day_type"] == "weekend"][["station_id", "hour", "mean_no2", "qualifies"]]
    pair = wd.merge(we, on=["station_id", "hour"], suffixes=("_weekday", "_weekend"))
    pair = pair[pair["qualifies_weekday"] & pair["qualifies_weekend"]].copy()
    pair["weekday_mean"] = pair["mean_no2_weekday"]
    pair["weekend_mean"] = pair["mean_no2_weekend"]
    pair["difference"] = pair["weekday_mean"] - pair["weekend_mean"]
    return pair[["station_id", "hour", "weekday_mean", "weekend_mean", "difference"]].reset_index(drop=True)


def build_hourly_difference_summary(diffs: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for h in range(24):
        vals = diffs[diffs["hour"] == h]["difference"]
        n = int(len(vals))
        ok = n >= MIN_STATIONS
        rows.append({
            "hour": h,
            "n_station_pairs": n,
            "median_difference": float(vals.median()) if ok else np.nan,
            "p25_difference": float(vals.quantile(0.25)) if ok else np.nan,
            "p75_difference": float(vals.quantile(0.75)) if ok else np.nan,
        })
    return pd.DataFrame(rows)


def build_station_summary(prof: pd.DataFrame, deduped: pd.DataFrame) -> pd.DataFrame:
    """Per-station summary with review flags. No station is excluded."""
    overall = deduped.groupby("station_id")["value"].mean()
    first = deduped.groupby("station_id")["dt"].min().dt.normalize()
    last = deduped.groupby("station_id")["dt"].max().dt.normalize()
    median_overall = overall.median()
    earliest = first.min()
    stations = sorted(overall.index)

    rows = []
    for s in stations:
        row = {
            "station_id": s,
            "first_date": first[s].date().isoformat(),
            "last_date": last[s].date().isoformat(),
            "overall_mean_all_valid": float(overall[s]),
        }
        for t in DAY_TYPES:
            sub = prof[(prof["station_id"] == s) & (prof["day_type"] == t)]
            q = sub[sub["qualifies"]]
            row[f"{t}_expected_days"] = int(sub["expected_days"].iloc[0])
            row[f"{t}_valid_obs"] = int(sub["valid_obs"].sum())
            row[f"{t}_qualifying_hours"] = int(len(q))
            row[f"{t}_qualifying_mean"] = float(q["mean_no2"].mean()) if len(q) else np.nan
            if len(q):
                peak = q.loc[q["mean_no2"].idxmax()]
                row[f"{t}_peak_hour"] = int(peak["hour"])
                row[f"{t}_peak_value"] = float(peak["mean_no2"])
            else:
                row[f"{t}_peak_hour"] = np.nan
                row[f"{t}_peak_value"] = np.nan

        notes = []
        low_flag = bool(overall[s] < LOW_MEAN_RATIO * median_overall)
        if low_flag:
            notes.append("Overall mean is below half the median station mean; retained as recorded, not verified against station metadata.")
        coverage_flag = bool(first[s] > earliest)
        if coverage_flag:
            notes.append(f"Coverage starts {first[s].date().isoformat()}, after the earliest station start {earliest.date().isoformat()}.")
        partners = [o for o in stations if o != s and (s.startswith(o + "/") or o.startswith(s + "/"))]
        name_flag = bool(partners)
        if name_flag:
            notes.append(f"Name shares a base with {', '.join(partners)}; kept as a distinct series, not verified as a duplicate.")
        row["low_mean_flag"] = low_flag
        row["coverage_start_flag"] = coverage_flag
        row["name_overlap_flag"] = name_flag
        row["review_note"] = " ".join(notes)
        rows.append(row)
    return pd.DataFrame(rows)


def station_checks(deduped: pd.DataFrame, summary: pd.DataFrame) -> dict:
    """Evidence for flagged stations: yearly means, and overlap between name-sharing stations."""
    checks = {}
    years = deduped["dt"].dt.year
    for _, r in summary.iterrows():
        s = r["station_id"]
        if r["low_mean_flag"]:
            sub = deduped[deduped["station_id"] == s]
            y = sub.groupby(years[sub.index])["value"]
            checks.setdefault(s, {})["yearly_mean"] = {str(k): round(float(v), 3) for k, v in y.mean().items()}
            checks[s]["yearly_valid_obs"] = {str(k): int(v) for k, v in y.size().items()}
        if r["name_overlap_flag"]:
            a = deduped[deduped["station_id"] == s].set_index("dt")["value"]
            entry = checks.setdefault(s, {})
            for o in summary["station_id"]:
                if o == s or not (s.startswith(o + "/") or o.startswith(s + "/")):
                    continue
                b = deduped[deduped["station_id"] == o].set_index("dt")["value"]
                both = pd.concat([a.rename("a"), b.rename("b")], axis=1, join="inner").dropna()
                entry[f"overlap_with_{o}"] = {
                    "overlapping_hours": int(len(both)),
                    "identical_share": round(float((both["a"] == both["b"]).mean()), 4) if len(both) else None,
                }
    return checks


def compare_with_existing(prof: pd.DataFrame, existing: Path) -> dict:
    if not existing.exists():
        return {"available": False}
    old = pd.read_csv(existing, dtype={"station_id": str}).rename(
        columns={"valid_obs": "old_valid_obs", "avg_no2": "old_avg_no2"}
    )
    m = prof.merge(old, on=["station_id", "hour", "day_type"], how="outer", indicator=True)
    both = m[m["_merge"] == "both"]
    diff = (both["mean_all_valid"] - both["old_avg_no2"]).abs()
    return {
        "available": True,
        "existing_cells": int(len(old)),
        "matched_cells": int(len(both)),
        "existing_only_cells": int((m["_merge"] == "right_only").sum()),
        "new_only_cells": int((m["_merge"] == "left_only").sum()),
        "valid_obs_mismatches": int((both["valid_obs"] != both["old_valid_obs"]).sum()),
        "max_abs_mean_difference": float(diff.max()) if len(both) else None,
    }


def _jsonable(obj):
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating, float)):
        return None if math.isnan(obj) else float(obj)
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    return obj


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Build Story 2 NO2 weekday/weekend outputs.")
    parser.add_argument("--clean", type=Path, default=DEFAULT_CLEAN)
    parser.add_argument("--existing", type=Path, default=DEFAULT_EXISTING)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    args = parser.parse_args(argv)

    obs, load_stats = load_no2(args.clean)
    deduped, dedupe_stats = dedupe_observations(obs)
    prof = build_station_hour_profiles(deduped)
    city = build_city_profile(prof)
    diffs = build_station_hour_differences(prof)
    hourly_diff = build_hourly_difference_summary(diffs)
    summary = build_station_summary(prof, deduped)
    checks = station_checks(deduped, summary)
    comparison = compare_with_existing(prof, args.existing)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    prof.drop(columns=["mean_all_valid"]).to_csv(
        args.out_dir / "story2_station_hour_profiles.csv", index=False, float_format="%.6f"
    )
    city.to_csv(args.out_dir / "story2_city_hourly_profile.csv", index=False, float_format="%.6f")
    diffs.to_csv(args.out_dir / "story2_station_hour_differences.csv", index=False, float_format="%.6f")
    hourly_diff.to_csv(args.out_dir / "story2_hourly_weekday_weekend_difference.csv", index=False, float_format="%.6f")
    summary.to_csv(args.out_dir / "story2_station_summary.csv", index=False, float_format="%.6f")

    qualifying = prof.groupby("day_type")["qualifies"].sum().to_dict()
    validation = {
        "assumptions": ASSUMPTIONS,
        "load": load_stats,
        "deduplication": dedupe_stats,
        "stations": int(prof["station_id"].nunique()),
        "station_hour_day_type_cells": int(len(prof)),
        "qualifying_cells_by_day_type": {k: int(v) for k, v in qualifying.items()},
        "min_coverage": MIN_COVERAGE,
        "min_stations_for_city_summary": MIN_STATIONS,
        "flagged_station_checks": checks,
        "comparison_with_existing_csv": comparison,
        "station_flags": summary.set_index("station_id")[
            ["low_mean_flag", "coverage_start_flag", "name_overlap_flag"]
        ].to_dict(orient="index"),
    }
    with open(args.out_dir / "story2_validation_summary.json", "w", encoding="utf-8") as fh:
        json.dump(_jsonable(validation), fh, indent=2)

    print(f"Wrote Story 2 outputs to {args.out_dir}")
    print(f"Stations: {validation['stations']}; qualifying cells: {validation['qualifying_cells_by_day_type']}")


if __name__ == "__main__":
    main()
