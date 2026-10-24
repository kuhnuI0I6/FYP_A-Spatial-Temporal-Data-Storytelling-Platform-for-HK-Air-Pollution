
from __future__ import annotations

import csv
import re
from pathlib import Path
from typing import Optional, Sequence

import pandas as pd

HEADER_HINTS = {
    "date",
    "time",
    "datetime",
    "station",
    "monitor",
    "site",
    "hour",
    "no2",
    "o3",
    "rsp",
    "fsp",
    "pm10",
    "pm2.5",
}


def detect_csv_header_row(path: Path, max_rows: int = 30) -> int:
    """Detect the actual column header in CSV files with metadata lines."""
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)

        for i, row in enumerate(reader):
            if i >= max_rows:
                break

            cleaned = [c.strip().lower() for c in row]
            non_empty = [c for c in cleaned if c]

            if len(non_empty) < 2:
                continue

            # Require actual column labels, not mentions in remarks.
            has_date = any(c in {"date", "datetime", "timestamp"} for c in non_empty)
            has_station = any(
                c in {"station", "station name", "monitoring station", "site"}
                for c in non_empty
            )
            has_hour = any(c in {"hour", "hr"} for c in non_empty)
            has_pollutant = any(
                c in {"no2", "o3", "rsp", "fsp", "so2", "nox", "co"}
                for c in non_empty
            )

            if has_date and has_station and has_hour and has_pollutant:
                return i

    return 0


def read_csv_with_detected_header(path: Path) -> pd.DataFrame:
    header_row = detect_csv_header_row(path)
    return pd.read_csv(
        path,
        skiprows=header_row,
        header=0,
        encoding="utf-8-sig",
    )


def first_existing_column(
    columns: Sequence[str], candidates: Sequence[str]
) -> Optional[str]:
    column_map = {c.lower().strip(): c for c in columns}

    for name in candidates:
        if name.lower() in column_map:
            return column_map[name.lower()]

    return None


def normalize_station_id(series: pd.Series) -> pd.Series:
    """Normalize station names for consistent grouping."""
    return (
        series.astype("string")
        .str.strip()
        .str.upper()
        .str.replace(r"\s+", "_", regex=True)
    )
