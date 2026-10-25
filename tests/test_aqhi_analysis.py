import unittest

import pandas as pd

from scripts.aqhi_analysis import (
    OUTPUT_COLUMNS,
    build_daily_maximum_category_counts,
    station_is_available,
)


def daily_rows() -> pd.DataFrame:
    rows = [
        ("a.csv", 1, "202001", "2020-01-01", "中西區", "1", "numeric", False, False, False, False),
        ("a.csv", 2, "202001", "2020-01-01", "中西區", "1*", "numeric_starred", True, False, False, False),
        ("a.csv", 3, "202001", "2020-01-01", "中西區", "10+", "high_category", False, True, False, False),
        ("a.csv", 4, "202001", "2020-01-01", "中西區", "10+*", "high_category_starred", True, True, False, False),
        ("a.csv", 5, "202001", "2020-01-01", "中西區", "", "blank", False, False, True, False),
        ("a.csv", 6, "202001", "2020-01-01", "中西區", "-*", "unresolved_marker_starred", True, False, True, True),
        ("a.csv", 7, "202001", "2020-01-01", "中西區", "?", "unknown", False, False, True, True),
        ("a.csv", 8, "202006", "2020-06-01", "南區", "5", "numeric", False, False, False, False),
        ("a.csv", 9, "202005", "2020-05-01", "北區", "5", "numeric", False, False, False, False),
    ]
    columns = [
        "source_file", "source_row_number", "source_month", "date_effective",
        "station_raw", "aqhi_raw", "aqhi_class", "star_flag",
        "high_category_flag", "missing_flag", "unresolved_flag",
    ]
    frame = pd.DataFrame(rows, columns=columns)
    frame["station_id"] = frame["station_raw"]
    frame["row_type"] = "daily_maximum"
    frame["is_daily_summary"] = True
    return frame


class TestAQHIAnalysis(unittest.TestCase):
    def test_monthly_counts_and_reconciliation(self):
        source = daily_rows()
        result = build_daily_maximum_category_counts(source)
        self.assertEqual(list(result.columns), OUTPUT_COLUMNS)
        self.assertEqual(int(result["category_count"].sum()), len(source))
        counts = result.set_index(["category", "star_status"])["category_count"]
        self.assertEqual(counts[("1", "unstarred")], 1)
        self.assertEqual(counts[("1", "starred")], 1)
        self.assertEqual(counts[("10+", "unstarred")], 1)
        self.assertEqual(counts[("10+", "starred")], 1)

    def test_quality_classes_are_separate_and_not_zero(self):
        result = build_daily_maximum_category_counts(daily_rows())
        self.assertEqual(set(result["category"]), {"1", "5", "10+", "missing", "unresolved", "unknown"})
        self.assertNotIn("0", set(result["category"]))
        first_group = result[result["source_month"] == "202001"].iloc[0]
        self.assertEqual(first_group["valid_numeric_observations"], 2)
        self.assertEqual(first_group["high_category_observations"], 2)
        self.assertEqual(first_group["missing_observations"], 1)
        self.assertEqual(first_group["unresolved_observations"], 1)
        self.assertEqual(first_group["unknown_observations"], 1)

    def test_availability_transition(self):
        self.assertFalse(station_is_available("南區", "202005"))
        self.assertFalse(station_is_available("北區", "202001"))
        self.assertTrue(station_is_available("南區", "202006"))
        self.assertTrue(station_is_available("北區", "202006"))
        self.assertTrue(station_is_available("中西區", "202001"))
        result = build_daily_maximum_category_counts(daily_rows())
        north = result[result["station_raw"] == "北區"]
        south = result[result["station_raw"] == "南區"]
        self.assertFalse(bool(north.iloc[0]["station_available"]))
        self.assertTrue(bool(south.iloc[0]["station_available"]))

    def test_missing_required_columns_and_duplicate_sources_fail(self):
        with self.assertRaises(ValueError):
            build_daily_maximum_category_counts(pd.DataFrame({"aqhi_raw": ["1"]}))
        duplicate = pd.concat([daily_rows().iloc[[0]], daily_rows().iloc[[0]]])
        with self.assertRaises(ValueError):
            build_daily_maximum_category_counts(duplicate)

    def test_empty_input_has_deterministic_schema(self):
        empty = daily_rows().iloc[0:0]
        result = build_daily_maximum_category_counts(empty)
        self.assertEqual(list(result.columns), OUTPUT_COLUMNS)
        self.assertTrue(result.empty)


if __name__ == "__main__":
    unittest.main()
