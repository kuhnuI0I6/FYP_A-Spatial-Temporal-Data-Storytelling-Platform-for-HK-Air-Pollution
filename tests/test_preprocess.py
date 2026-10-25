import unittest
from tempfile import TemporaryDirectory
from pathlib import Path

import pandas as pd

from scripts.preprocess import build_outputs, parse_datetime


class TestParseDatetime(unittest.TestCase):
    def test_source_hours_one_and_24_use_existing_zero_based_assumption(self):
        frame = pd.DataFrame(
            {"DATE": ["1/1/2023", "1/1/2023"], "HOUR": ["01", "24"]}
        )

        result = parse_datetime(frame)

        self.assertEqual(
            result.tolist(),
            [pd.Timestamp("2023-01-01 00:00"), pd.Timestamp("2023-01-01 23:00")],
        )

    def test_invalid_date_and_out_of_range_hours_become_nat(self):
        frame = pd.DataFrame(
            {
                "DATE": ["31/2/2023", "1/1/2023", "1/1/2023"],
                "HOUR": ["01", "00", "25"],
            }
        )

        result = parse_datetime(frame)

        self.assertTrue(result.isna().all())

    def test_build_outputs_reports_quality_counts(self):
        frame = pd.DataFrame(
            {
                "DATE": ["1/1/2023", "1/1/2023"],
                "HOUR": ["01", "01"],
                "STATION": ["Central", ""],
                "NO2": ["10", "N.A."],
                "source_file": "sample.csv",
            }
        )

        with TemporaryDirectory() as td:
            result = build_outputs(frame, Path(td))

        quality = result["data_quality"]
        self.assertEqual(quality["duplicate_date_hour_station_keys"], 0)
        self.assertEqual(quality["missing_station_names"], 1)
        self.assertEqual(quality["invalid_timestamps"], 0)
        self.assertEqual(quality["unexpected_pollutant_columns"], [])


if __name__ == "__main__":
    unittest.main()
