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
    """Detect likely header row for CSVs that may contain intro metadata lines."""
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        for i, row in enumerate(reader):
            if i >= max_rows:
                break
            cleaned = [c.strip() for c in row]
            non_empty = [c for c in cleaned if c]
            if len(non_empty) < 2:
                continue
            lowered = [c.lower() for c in non_empty]
            hint_hits = sum(any(h in cell for h in HEADER_HINTS) for cell in lowered)
            alpha_cells = sum(bool(re.search(r"[A-Za-z]", c)) for c in non_empty)
            if hint_hits >= 1 and alpha_cells >= 2:
                return i
    return 0


def read_csv_with_detected_header(path: Path) -> pd.DataFrame:
    header_row = detect_csv_header_row(path)
    return pd.read_csv(path, header=header_row, encoding="utf-8-sig")


def first_existing_column(columns: Sequence[str], candidates: Sequence[str]) -> Optional[str]:
    column_map = {c.lower().strip(): c for c in columns}
    for name in candidates:
        if name.lower() in column_map:
            return column_map[name.lower()]
    return None


def normalize_station_id(series: pd.Series) -> pd.Series:
    return series.astype(str).str.strip().str.upper().replace({"NAN": pd.NA, "": pd.NA})
