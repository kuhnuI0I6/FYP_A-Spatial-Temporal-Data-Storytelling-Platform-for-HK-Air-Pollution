import csv
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import pandas as pd

from scripts.aqhi import (
    DAILY_SUMMARY_LABEL,
    classify_aqhi_token,
    discover_aqhi_files,
    extract_month_key,
    export_aqhi_outputs,
    load_aqhi_directory,
    parse_aqhi_file,
)


def write_aqhi_file(path: Path, stations: list[str], rows: list[list[str]]) -> None:
    metadata = [["metadata"] for _ in range(7)]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerows(metadata)
        writer.writerow(["日期", "時間", *stations])
        writer.writerows(rows)


class TestAQHIHelpers(unittest.TestCase):
    def test_discover_files_including_parenthesized_suffix(self):
        with TemporaryDirectory() as td:
            directory = Path(td)
            (directory / "202001_ChT.csv").touch()
            (directory / "202106_ChT (1).csv").touch()
            files, report = discover_aqhi_files(directory)
            self.assertEqual([path.name for path in files], ["202001_ChT.csv", "202106_ChT (1).csv"])
            self.assertEqual(report["duplicate_month_keys"], {})

    def test_extract_and_validate_month_key(self):
        self.assertEqual(extract_month_key("202106_ChT (1).csv"), "202106")
        with self.assertRaises(ValueError):
            extract_month_key("202013_ChT.csv")
        with self.assertRaises(ValueError):
            extract_month_key("not-an-aqhi-file.csv")

    def test_classify_tokens_without_zero_filling(self):
        self.assertEqual(classify_aqhi_token("5")["aqhi_numeric"], 5)
        starred = classify_aqhi_token("5*")
        self.assertEqual(starred["aqhi_class"], "numeric_starred")
        self.assertTrue(starred["star_flag"])
        self.assertTrue(pd.isna(classify_aqhi_token("10+")["aqhi_numeric"]))
        self.assertEqual(classify_aqhi_token("10+*")["aqhi_class"], "high_category_starred")
        self.assertEqual(classify_aqhi_token(" ")["aqhi_class"], "blank")
        self.assertEqual(classify_aqhi_token("-*")["aqhi_class"], "unresolved_marker_starred")
        self.assertEqual(classify_aqhi_token("*")["aqhi_class"], "unresolved_marker_starred")


class TestAQHIFileParsing(unittest.TestCase):
    def test_header_date_inheritance_hour_labels_and_summary_separation(self):
        with TemporaryDirectory() as td:
            path = Path(td) / "202001_ChT.csv"
            write_aqhi_file(
                path,
                ["中西區", "東區"],
                [
                    ["2020-01-01", "01", "3", "5*"],
                    ["", "24", "", "10+"],
                    ["", DAILY_SUMMARY_LABEL, "6", "6"],
                ],
            )
            hourly, summaries, report = parse_aqhi_file(path)

        self.assertEqual(report["header_row"], 7)
        self.assertEqual(len(hourly), 4)
        self.assertEqual(len(summaries), 2)
        self.assertEqual(hourly.iloc[2]["date_raw"], "")
        self.assertEqual(str(hourly.iloc[2]["date_effective"].date()), "2020-01-01")
        self.assertTrue(hourly.iloc[2]["date_was_inherited"])
        self.assertEqual(hourly.iloc[0]["hour_label"], "01")
        self.assertEqual(hourly.iloc[2]["hour_label"], "24")
        self.assertTrue((summaries["is_daily_summary"]).all())
        self.assertEqual(report["daily_summary_rows"], 1)

    def test_sixteen_and_eighteen_station_layouts(self):
        with TemporaryDirectory() as td:
            directory = Path(td)
            write_aqhi_file(
                directory / "202005_ChT.csv",
                [f"S{i}" for i in range(16)],
                [["2020-05-01", "01", *([ "1"] * 16)]],
            )
            write_aqhi_file(
                directory / "202006_ChT (1).csv",
                [f"S{i}" for i in range(16)] + ["南區", "北區"],
                [["2020-06-01", "01", *([ "1"] * 18)]],
            )
            _, _, report = load_aqhi_directory(directory)

        self.assertEqual(report["files"][0]["station_count"], 16)
        self.assertEqual(report["files"][1]["station_count"], 18)

    def test_invalid_hours_and_duplicate_keys_are_reported(self):
        with TemporaryDirectory() as td:
            path = Path(td) / "202001_ChT.csv"
            write_aqhi_file(
                path,
                ["中西區"],
                [
                    ["2020-01-01", "01", "1"],
                    ["2020-01-01", "01", "2"],
                    ["2020-01-01", "25", "3"],
                ],
            )
            hourly, _, report = parse_aqhi_file(path)

        self.assertEqual(len(hourly), 2)
        self.assertEqual(report["invalid_hours"], 1)
        self.assertEqual(report["duplicate_date_hour_station_keys"], 1)

    def test_malformed_source_returns_parse_error(self):
        with TemporaryDirectory() as td:
            path = Path(td) / "202001_ChT.csv"
            path.write_text("not a valid AQHI header\n", encoding="utf-8-sig")
            hourly, summaries, report = parse_aqhi_file(path)

        self.assertTrue(hourly.empty)
        self.assertTrue(summaries.empty)
        self.assertTrue(report["parse_errors"])

    def test_missing_directory_has_empty_report(self):
        with TemporaryDirectory() as td:
            hourly, summaries, report = load_aqhi_directory(Path(td) / "missing")
        self.assertTrue(hourly.empty)
        self.assertTrue(summaries.empty)
        self.assertEqual(report["files_discovered"], 0)


class TestAQHIExport(unittest.TestCase):
    def test_export_writes_separate_outputs_and_preserves_schema_and_tokens(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            source = root / "AQHI"
            output = root / "output"
            source.mkdir()
            write_aqhi_file(
                source / "202001_ChT.csv",
                ["中西區", "東區"],
                [
                    ["2020-01-01", "01", "5*", "10+"],
                    ["", "24", "", "10+*"],
                    ["", DAILY_SUMMARY_LABEL, "*", "-*"],
                ],
            )

            result = export_aqhi_outputs(source, output)
            hourly_path = output / "clean" / "aqhi_hourly.csv"
            summary_path = output / "clean" / "aqhi_daily_summary.csv"
            report_path = output / "analysis" / "aqhi_report.json"

            self.assertEqual(set(result["paths"]), {"hourly", "daily_summary", "report"})
            self.assertTrue(hourly_path.exists())
            self.assertTrue(summary_path.exists())
            self.assertTrue(report_path.exists())

            hourly = pd.read_csv(hourly_path, keep_default_na=False)
            summaries = pd.read_csv(summary_path, keep_default_na=False)
            report = json.loads(report_path.read_text(encoding="utf-8"))

        self.assertEqual(list(hourly.columns), [
            "source_file", "source_month", "source_row_number", "date_raw",
            "date_effective", "date_was_inherited", "hour_raw", "hour_label",
            "station_raw", "station_id", "aqhi_raw", "aqhi_numeric",
            "aqhi_class", "star_flag", "high_category_flag", "missing_flag",
            "unresolved_flag", "parse_reason", "row_type", "is_daily_summary",
        ])
        self.assertEqual(len(hourly), 4)
        self.assertEqual(len(summaries), 2)
        self.assertIn("10+", set(hourly["aqhi_raw"]))
        self.assertIn("10+*", set(hourly["aqhi_raw"]))
        self.assertIn("numeric_starred", set(hourly["aqhi_class"]))
        self.assertIn("high_category", set(hourly["aqhi_class"]))
        self.assertIn("high_category_starred", set(hourly["aqhi_class"]))
        self.assertEqual(hourly.loc[hourly["aqhi_raw"] == "10+", "aqhi_numeric"].iloc[0], "")
        self.assertEqual(report["hourly_rows"], 2)
        self.assertEqual(report["daily_summary_rows"], 1)
        self.assertIn("date_inheritance", report)
        self.assertIn("missingness_by_month_station", report)
        self.assertEqual(len(report["missingness_by_month_station"]), 2)

    def test_export_refuses_to_overwrite_existing_outputs(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            source = root / "AQHI"
            output = root / "output"
            source.mkdir()
            write_aqhi_file(source / "202001_ChT.csv", ["中西區"], [["2020-01-01", "01", "1"]])
            export_aqhi_outputs(source, output)

            with self.assertRaises(FileExistsError):
                export_aqhi_outputs(source, output)

    def test_export_creates_missing_output_directories_and_null_like_values(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            source = root / "AQHI"
            output = root / "new-output"
            source.mkdir()
            write_aqhi_file(
                source / "202001_ChT.csv",
                ["中西區"],
                [["2020-01-01", "01", ""]],
            )
            export_aqhi_outputs(source, output)
            rows = pd.read_csv(
                output / "clean" / "aqhi_hourly.csv", keep_default_na=False
            )

        self.assertEqual(rows.loc[0, "aqhi_raw"], "")
        self.assertEqual(rows.loc[0, "aqhi_numeric"], "")
        self.assertNotEqual(rows.loc[0, "aqhi_numeric"], 0)


if __name__ == "__main__":
    unittest.main()
