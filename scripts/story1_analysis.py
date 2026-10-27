"""Story 1 analysis: pollutant concentrations under lower vs higher TC warning signals.

Descriptive associations only; results are not causal. The EPD HOUR convention
(HOUR 01 -> 00:00 on the same date) and the HKT timezone are unverified working
assumptions and are recorded as such in every output summary.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from decimal import Decimal
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CLEAN = REPO_ROOT / "output" / "clean" / "air_quality_long.csv"
DEFAULT_WORKBOOK = REPO_ROOT / "reference" / "hko_tropical_cyclone_signal_intervals_2020_2025.xlsx"
DEFAULT_OUT_DIR = REPO_ROOT / "output" / "analysis" / "story1"

HOUR = pd.Timedelta(hours=1)
ZERO = pd.Timedelta(0)
EVENT_TOLERANCE = pd.Timedelta(minutes=1)
EXCEL_EPOCH = pd.Timestamp("1899-12-30")
POLLUTANTS = ["FSP", "NO2", "O3", "RSP"]
LOW_SIGNALS = {1, 3}
HIGH_SIGNALS = {8, 9, 10}
PRIMARY_PERCENT = 0.75
COMPLETENESS_LEVELS = (0.5, 0.75, 0.9)
MIN_VALID_HOURS = 2
SENSITIVITY_MIN_VALID = 6
MIN_BASELINE_FREE_HOURS = 12
PRIMARY_WINDOW_HOURS = 24
SENSITIVITY_WINDOW_HOURS = 48
TIMING_SHIFTS = (-1, 0, 1)
ASSUMPTIONS = {
    "timezone": "HKT (UTC+8) - unverified working assumption",
    "hour_convention": "HOUR 01 -> 00:00 same date, HOUR 24 -> 23:00 same date - unverified working assumption",
    "bin_convention": "hourly bins [h, h+1); observation timestamp is the assumed interval start",
    "baseline_rule": "24 h and 48 h before/after windows; a window is full if all raw bins are free, reduced if >= 12 free bins (MIN_BASELINE_FREE_HOURS) but not all, otherwise excluded",
    "48h_comparison_rule": "window_48h_full_only keeps only events whose before AND after 48 h windows are both full",
}

WORKBOOK_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"


# ---------------------------------------------------------------------------
# Signal labels and workbook loading
# ---------------------------------------------------------------------------

def signal_number(label: str) -> int:
    """Return the numeric signal from labels such as '1', '8 NE'."""
    return int(str(label).strip().split()[0])


def signal_group(label: str) -> str:
    """Map a signal label to 'low' (1, 3) or 'high' (8, 9, 10). Other values raise."""
    number = signal_number(label)
    if number in LOW_SIGNALS:
        return "low"
    if number in HIGH_SIGNALS:
        return "high"
    raise ValueError(f"Unexpected signal label: {label!r}")


def excel_serial_to_timestamp(serial: float) -> pd.Timestamp:
    """Convert an Excel serial datetime to a minute-rounded naive timestamp."""
    return (EXCEL_EPOCH + pd.to_timedelta(float(serial), unit="D")).round("min")


def is_unnamed(storm_name: str) -> bool:
    return str(storm_name).strip().lower().startswith("no name")


def _sheet_path(archive: zipfile.ZipFile, sheet_name: str) -> str:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    rel_id = None
    for sheet in workbook.iter(f"{WORKBOOK_NS}sheet"):
        if sheet.get("name") == sheet_name:
            rel_id = sheet.get(f"{REL_NS}id")
            break
    if rel_id is None:
        raise ValueError(f"Worksheet not found: {sheet_name}")
    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    for rel in rels.iter(f"{PKG_REL_NS}Relationship"):
        if rel.get("Id") == rel_id:
            return "xl/" + rel.get("Target").lstrip("/").removeprefix("xl/")
    raise ValueError(f"Relationship not found for sheet: {sheet_name}")


def read_signal_intervals(path: Path = DEFAULT_WORKBOOK) -> pd.DataFrame:
    """Read the 'Signal Intervals' sheet with stdlib XML parsing (openpyxl is not installed)."""
    with zipfile.ZipFile(path) as archive:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.iter(f"{WORKBOOK_NS}si"):
                shared.append("".join(t.text or "" for t in item.iter(f"{WORKBOOK_NS}t")))
        sheet = ET.fromstring(archive.read(_sheet_path(archive, "Signal Intervals")))

    table: list[dict[str, str]] = []
    for row in sheet.iter(f"{WORKBOOK_NS}row"):
        values: dict[str, str] = {}
        for cell in row.findall(f"{WORKBOOK_NS}c"):
            column = re.match(r"[A-Z]+", cell.get("r")).group(0)
            cell_type = cell.get("t")
            if cell_type == "inlineStr":
                value = "".join(t.text or "" for t in cell.iter(f"{WORKBOOK_NS}t"))
            else:
                node = cell.find(f"{WORKBOOK_NS}v")
                if node is None or node.text is None:
                    continue
                value = shared[int(node.text)] if cell_type == "s" else node.text
            values[column] = value
        if values:
            table.append(values)

    header = table[0]
    records = []
    for row in table[1:]:
        records.append({header[col]: row.get(col) for col in header})
    df = pd.DataFrame(records)

    df["record_id"] = df["record_id"].astype(int)
    df["signal_label"] = df["signal_number"].astype(str).str.strip()
    df["signal_group"] = df["signal_label"].map(signal_group)
    df["start"] = df["start_datetime_hkt"].astype(float).map(excel_serial_to_timestamp)
    df["end"] = df["end_datetime_hkt"].astype(float).map(excel_serial_to_timestamp)
    df["duration_minutes"] = df["duration_minutes"].astype(int)
    df["storm_name"] = df["storm_name"].astype(str).str.strip()
    if (df["end"] <= df["start"]).any():
        raise ValueError("Found a warning interval whose end is not after its start.")
    df = df.sort_values(["start", "record_id"]).reset_index(drop=True)
    return df[["record_id", "intensity", "storm_name", "signal_label", "signal_group",
               "start", "end", "duration_minutes", "source_record_row"]]


# ---------------------------------------------------------------------------
# Event construction
# ---------------------------------------------------------------------------

def _continues_event(prev: pd.Series, cur: pd.Series) -> bool:
    """Consecutive intervals belong to one event only for the same named system."""
    if is_unnamed(prev["storm_name"]) or is_unnamed(cur["storm_name"]):
        return False
    if prev["storm_name"].lower() != cur["storm_name"].lower():
        return False
    if prev["start"].year != cur["start"].year:
        return False
    return abs(cur["start"] - prev["end"]) <= EVENT_TOLERANCE


def assign_event_ids(intervals: pd.DataFrame) -> pd.DataFrame:
    """Add event_id (E01, E02, ...) in start order. Input must be sorted by start."""
    df = intervals.copy()
    event_numbers: list[int] = []
    current = 0
    prev = None
    for _, row in df.iterrows():
        if prev is None or not _continues_event(prev, row):
            current += 1
        event_numbers.append(current)
        prev = row
    df["event_id"] = [f"E{n:02d}" for n in event_numbers]
    return df


def build_event_table(intervals: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for event_id, group in intervals.groupby("event_id", sort=True):
        name = group["storm_name"].iloc[0]
        unnamed = is_unnamed(name)
        groups = set(group["signal_group"])
        rows.append({
            "event_id": event_id,
            "storm_name": name,
            "unnamed": unnamed,
            "name_ambiguity_note": (
                "Combined unnamed record kept as one event; source name contains '/'"
                if unnamed and "/" in name else ""
            ),
            "start_hkt": group["start"].min(),
            "end_hkt": group["end"].max(),
            "n_intervals": len(group),
            "signal_labels": " | ".join(group["signal_label"]),
            "has_low": "low" in groups,
            "has_high": "high" in groups,
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Hourly classification
# ---------------------------------------------------------------------------

def classify_hours(intervals: pd.DataFrame) -> pd.DataFrame:
    """Classify each touched hourly bin [h, h+1) as 'pure' or 'transition'.

    A bin is pure when exactly one interval overlaps it and that overlap covers the
    whole hour. A bin that partly overlaps an interval, or that overlaps two or more
    intervals, is a transition hour. Bins with no overlap are not returned (outside).
    """
    touched: dict[pd.Timestamp, list[tuple[int, pd.Timedelta]]] = {}
    for idx, row in intervals.iterrows():
        hour = row["start"].floor("h")
        while hour < row["end"]:
            overlap = min(hour + HOUR, row["end"]) - max(hour, row["start"])
            if overlap > ZERO:
                touched.setdefault(hour, []).append((idx, overlap))
            hour += HOUR

    rows = []
    for hour, items in touched.items():
        if len(items) == 1 and items[0][1] == HOUR:
            iv = intervals.loc[items[0][0]]
            rows.append({
                "bin_start": hour,
                "hour_class": "pure",
                "event_id": iv["event_id"],
                "record_id": int(iv["record_id"]),
                "signal_label": iv["signal_label"],
                "signal_group": iv["signal_group"],
            })
        else:
            involved = [intervals.loc[i] for i, _ in items]
            rows.append({
                "bin_start": hour,
                "hour_class": "transition",
                "event_id": ";".join(sorted({iv["event_id"] for iv in involved})),
                "record_id": ";".join(str(int(iv["record_id"])) for iv in involved),
                "signal_label": ";".join(iv["signal_label"] for iv in involved),
                "signal_group": None,
            })
    return pd.DataFrame(rows).sort_values("bin_start").reset_index(drop=True)


# ---------------------------------------------------------------------------
# Baseline windows
# ---------------------------------------------------------------------------

def window_bins(start: pd.Timestamp, end: pd.Timestamp) -> pd.DatetimeIndex:
    """Hourly bins lying entirely inside [start, end). Partial bins are not returned."""
    first = start.ceil("h")
    last_exclusive = end.floor("h")
    if last_exclusive <= first:
        return pd.DatetimeIndex([])
    return pd.date_range(first, last_exclusive - HOUR, freq="h")


def build_baseline_tables(
    events: pd.DataFrame,
    window_hours: int,
    touched_starts: set[pd.Timestamp],
    grid_start: pd.Timestamp,
    grid_end: pd.Timestamp,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return (window summary, free bins) for before/after windows of one length.

    A free bin is fully inside the window, inside the data grid, not touched by any
    warning interval, and contained in exactly one baseline window of this length.
    Windows with fewer than MIN_BASELINE_FREE_HOURS free bins are excluded.
    """
    window = pd.Timedelta(hours=window_hours)
    specs = []
    for ev in events.itertuples(index=False):
        specs.append((ev.event_id, "before", ev.start_hkt - window, ev.start_hkt))
        specs.append((ev.event_id, "after", ev.end_hkt, ev.end_hkt + window))

    bins_per_spec = [window_bins(s, t) for _, _, s, t in specs]
    membership = Counter(hour for bins in bins_per_spec for hour in bins)

    summary_rows, free_rows = [], []
    for (event_id, side, start, end), bins in zip(specs, bins_per_spec):
        in_grid = [b for b in bins if grid_start <= b <= grid_end]
        contaminated = [b for b in in_grid if b in touched_starts]
        shared = [b for b in in_grid if b not in touched_starts and membership[b] > 1]
        free = [b for b in in_grid if b not in touched_starts and membership[b] == 1]
        if len(free) == len(bins):
            status = "full"
        elif len(free) >= MIN_BASELINE_FREE_HOURS:
            status = "reduced"
        else:
            status = "excluded"
        summary_rows.append({
            "event_id": event_id,
            "side": side,
            "window_hours": window_hours,
            "window_start": start,
            "window_end": end,
            "raw_full_bins": len(bins),
            "in_grid_bins": len(in_grid),
            "warning_contaminated_bins": len(contaminated),
            "shared_bins": len(shared),
            "free_bins": len(free),
            "status": status,
        })
        if status != "excluded":
            free_rows.extend(
                {"event_id": event_id, "side": side, "window_hours": window_hours, "bin_start": b}
                for b in free
            )
    return pd.DataFrame(summary_rows), pd.DataFrame(free_rows)


# ---------------------------------------------------------------------------
# Observations, completeness and medians
# ---------------------------------------------------------------------------

def required_valid(n: int, percent: float) -> int:
    """Minimum valid hours: max(2, ceil(percent * n)), using exact decimal arithmetic."""
    return max(MIN_VALID_HOURS, math.ceil(Decimal(str(percent)) * n))


def load_observations(clean_path: Path = DEFAULT_CLEAN, shift_hours: int = 0) -> pd.DataFrame:
    """Load clean EPD rows. shift_hours moves each observation for timing sensitivity only."""
    df = pd.read_csv(
        clean_path,
        usecols=["datetime", "station_id", "pollutant", "value"],
        parse_dates=["datetime"],
    )
    df = df[df["pollutant"].isin(POLLUTANTS)].copy()
    duplicated = df.duplicated(["datetime", "station_id", "pollutant"]).sum()
    if duplicated:
        raise ValueError(f"Found {duplicated} duplicate observation keys in clean data.")
    df["obs_hour"] = df["datetime"] + pd.Timedelta(hours=shift_hours)
    return df[["obs_hour", "station_id", "pollutant", "value"]]


def summarise_units(rows: pd.DataFrame, keys: list[str]) -> pd.DataFrame:
    """Summarise joined observations per unit. n counts station-present rows (NaN included)."""
    grouped = rows.groupby(keys, sort=True)
    summary = grouped.agg(
        n_eligible=("value", "size"),
        n_valid=("value", "count"),
        n_zero=("value", lambda s: int((s == 0).sum())),
        median=("value", "median"),
    ).reset_index()
    for percent in COMPLETENESS_LEVELS:
        label = int(round(percent * 100))
        required = summary["n_eligible"].map(lambda n, p=percent: required_valid(n, p))
        summary[f"required_valid_{label}"] = required
        summary[f"retained_{label}"] = summary["n_valid"] >= required
    summary["retained_6"] = summary["retained_75"] & (summary["n_valid"] >= SENSITIVITY_MIN_VALID)
    return summary


def unit_medians(observations: pd.DataFrame, pure_bins: pd.DataFrame) -> pd.DataFrame:
    """Event x station x pollutant x signal-group medians from pure hours only."""
    pure = pure_bins[pure_bins["hour_class"] == "pure"][["bin_start", "event_id", "signal_group"]]
    joined = observations.merge(pure, left_on="obs_hour", right_on="bin_start", how="inner")
    return summarise_units(joined, ["event_id", "signal_group", "station_id", "pollutant"])


def period_medians(observations: pd.DataFrame, free_bins: pd.DataFrame) -> pd.DataFrame:
    """Event x station x pollutant x before/after medians from free baseline hours."""
    joined = observations.merge(free_bins, left_on="obs_hour", right_on="bin_start", how="inner")
    return summarise_units(joined, ["event_id", "window_hours", "side", "station_id", "pollutant"])


def build_pairs(units: pd.DataFrame, retained_column: str = "retained_75") -> pd.DataFrame:
    """Pair low and high medians within event x station x pollutant; diff = high - low."""
    kept = units[units[retained_column]]
    keys = ["event_id", "station_id", "pollutant"]
    low = kept[kept["signal_group"] == "low"][keys + ["median", "n_valid"]].rename(
        columns={"median": "median_low", "n_valid": "n_valid_low"}
    )
    high = kept[kept["signal_group"] == "high"][keys + ["median", "n_valid"]].rename(
        columns={"median": "median_high", "n_valid": "n_valid_high"}
    )
    paired = low.merge(high, on=keys, how="inner")
    paired["diff_high_minus_low"] = paired["median_high"] - paired["median_low"]
    return paired


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def build_grid(observations: pd.DataFrame) -> tuple[pd.Timestamp, pd.Timestamp]:
    return observations["obs_hour"].min(), observations["obs_hour"].max()


def run_analysis(
    observations: pd.DataFrame,
    intervals: pd.DataFrame,
    window_hours: int = PRIMARY_WINDOW_HOURS,
) -> dict[str, pd.DataFrame]:
    """Run classification, baselines, unit medians and pairs for one timing setting."""
    grid_start, grid_end = build_grid(observations)
    pure_and_transition = classify_hours(intervals)
    touched = set(pure_and_transition["bin_start"])
    events = build_event_table(intervals)
    windows, free = build_baseline_tables(events, window_hours, touched, grid_start, grid_end)
    units = unit_medians(observations, pure_and_transition)
    return {
        "hour_classes": pure_and_transition,
        "events": events,
        "baseline_windows": windows,
        "free_bins": free,
        "units": units,
        "period_medians": period_medians(observations, free),
        "pairs_75": build_pairs(units, "retained_75"),
        "pairs_6": build_pairs(units, "retained_6"),
    }


def write_outputs(results: dict[str, pd.DataFrame], intervals: pd.DataFrame, out_dir: Path,
                  summary: dict) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    intervals.to_csv(out_dir / "story1_timeline_segments.csv", index=False)
    results["events"].to_csv(out_dir / "story1_events.csv", index=False)
    results["hour_classes"].to_csv(out_dir / "story1_hour_bins.csv", index=False)
    results["units"].to_csv(out_dir / "story1_unit_medians.csv", index=False)
    results["pairs_75"].to_csv(out_dir / "story1_pairs.csv", index=False)
    results["baseline_windows"].to_csv(out_dir / "story1_baseline_windows.csv", index=False)
    results["period_medians"].to_csv(out_dir / "story1_period_medians.csv", index=False)
    (out_dir / "story1_validation_summary.json").write_text(
        json.dumps(summary, indent=2, default=str), encoding="utf-8"
    )


def full_window_event_ids(windows: pd.DataFrame) -> set[str]:
    """Events whose before AND after windows are both 'full' (reduced/excluded sides fail)."""
    full = windows[windows["status"] == "full"]
    sides_full = full.groupby("event_id")["side"].nunique()
    return set(sides_full[sides_full == 2].index)


def restrict_to_full_windows(units: pd.DataFrame, windows: pd.DataFrame) -> pd.DataFrame:
    """Keep only units whose event has both before and after windows marked full."""
    return units[units["event_id"].isin(full_window_event_ids(windows))]


ROLE_PRIMARY = "primary_24h"
ROLE_TIMING = "timing_sensitivity"
ROLE_48H_TRANSPARENCY = "transparency_only_48h_all_events"
ROLE_48H_SENSITIVITY = "sensitivity_48h_full_windows_only"


def summarise_variant(
    name: str, shift: int, window_hours: int, units: pd.DataFrame,
    pairs: pd.DataFrame, windows: pd.DataFrame, full_windows_only: bool = False,
    role: str = "unspecified",
) -> dict:
    """Build one sensitivity-summary row; window status counts must sum to windows_total.

    eligible_events: events whose before AND after windows of this length are both
    'full' (the events the full-window filter keeps).
    paired_events_75: events that contribute at least one paired low/high triple.
    """
    status_counts = windows["status"].value_counts()
    counts = {status: int(status_counts.get(status, 0)) for status in ("full", "reduced", "excluded")}
    windows_total = len(windows)
    if sum(counts.values()) != windows_total:
        raise ValueError(f"{name}: status counts {counts} do not sum to {windows_total}")
    return {
        "variant": name,
        "role": role,
        "shift_hours": shift,
        "window_hours": window_hours,
        "full_windows_only": full_windows_only,
        "eligible_events": len(full_window_event_ids(windows)),
        "units_total": len(units),
        "units_retained_75": int(units["retained_75"].sum()),
        "units_retained_6": int(units["retained_6"].sum()),
        "paired_triples_75": len(pairs),
        "paired_events_75": int(pairs["event_id"].nunique()) if len(pairs) else 0,
        "paired_stations_75": int(pairs["station_id"].nunique()) if len(pairs) else 0,
        "windows_total": windows_total,
        "windows_full": counts["full"],
        "windows_reduced": counts["reduced"],
        "windows_excluded": counts["excluded"],
    }


def sensitivity_summary(intervals: pd.DataFrame, clean_path: Path) -> pd.DataFrame:
    """One row per analysis variant: primary, 6-valid, +/-1 h timing shifts, 48 h windows."""
    variants = [
        ("primary", 0, PRIMARY_WINDOW_HOURS, False, ROLE_PRIMARY),
        ("timing_shift_-1h", -1, PRIMARY_WINDOW_HOURS, False, ROLE_TIMING),
        ("timing_shift_+1h", 1, PRIMARY_WINDOW_HOURS, False, ROLE_TIMING),
        ("window_48h_all_events", 0, SENSITIVITY_WINDOW_HOURS, False, ROLE_48H_TRANSPARENCY),
        ("window_48h_full_only", 0, SENSITIVITY_WINDOW_HOURS, True, ROLE_48H_SENSITIVITY),
    ]
    rows = []
    for name, shift, window_hours, full_only, role in variants:
        observations = load_observations(clean_path, shift)
        results = run_analysis(observations, intervals, window_hours)
        units = results["units"]
        windows = results["baseline_windows"]
        pairs = results["pairs_75"]
        if full_only:
            units = restrict_to_full_windows(units, windows)
            pairs = build_pairs(units, "retained_75")
        rows.append(summarise_variant(
            name, shift, window_hours, units, pairs, windows, full_only, role,
        ))
    return pd.DataFrame(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Story 1 analysis outputs.")
    parser.add_argument("--clean", type=Path, default=DEFAULT_CLEAN)
    parser.add_argument("--workbook", type=Path, default=DEFAULT_WORKBOOK)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUT_DIR)
    args = parser.parse_args()

    intervals = assign_event_ids(read_signal_intervals(args.workbook))
    observations = load_observations(args.clean)
    results = run_analysis(observations, intervals, PRIMARY_WINDOW_HOURS)
    summary = {
        "assumptions": ASSUMPTIONS,
        "n_intervals": len(intervals),
        "n_events": int(results["events"].shape[0]),
    }
    write_outputs(results, intervals, args.output_dir, summary)
    sensitivity = sensitivity_summary(intervals, args.clean)
    sensitivity.to_csv(args.output_dir / "story1_sensitivity_summary.csv", index=False)
    print(json.dumps(summary, indent=2, default=str))
    print(sensitivity.to_string(index=False))


if __name__ == "__main__":
    main()
