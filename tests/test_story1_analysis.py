import unittest

import numpy as np
import pandas as pd

from scripts.story1_analysis import (
    DEFAULT_WORKBOOK,
    assign_event_ids,
    build_baseline_tables,
    build_pairs,
    classify_hours,
    excel_serial_to_timestamp,
    full_window_event_ids,
    read_signal_intervals,
    required_valid,
    restrict_to_full_windows,
    signal_group,
    summarise_units,
    summarise_variant,
    window_bins,
)


def make_intervals(rows):
    """rows: (record_id, storm_name, signal_label, start, end)."""
    records = []
    for record_id, name, label, start, end in rows:
        records.append({
            "record_id": record_id,
            "intensity": "",
            "storm_name": name,
            "signal_label": label,
            "signal_group": signal_group(label),
            "start": pd.Timestamp(start),
            "end": pd.Timestamp(end),
            "duration_minutes": 0,
            "source_record_row": record_id,
        })
    return pd.DataFrame(records)


class SignalLabelTests(unittest.TestCase):
    def test_low_and_high_groups(self):
        self.assertEqual(signal_group("1"), "low")
        self.assertEqual(signal_group("3"), "low")
        self.assertEqual(signal_group("8 NE"), "high")
        self.assertEqual(signal_group("8 NW"), "high")
        self.assertEqual(signal_group("9"), "high")
        self.assertEqual(signal_group("10"), "high")

    def test_unexpected_signal_raises(self):
        with self.assertRaises(ValueError):
            signal_group("2")

    def test_excel_serial_conversion(self):
        self.assertEqual(
            excel_serial_to_timestamp(43994.84722222222),
            pd.Timestamp("2020-06-12 20:20"),
        )


class EventIdTests(unittest.TestCase):
    def test_consecutive_same_name_merges(self):
        df = make_intervals([
            (1, "NURI", "1", "2020-06-12 00:00", "2020-06-12 06:00"),
            (2, "NURI", "3", "2020-06-12 06:00", "2020-06-12 12:00"),
        ])
        self.assertEqual(list(assign_event_ids(df)["event_id"]), ["E01", "E01"])

    def test_gap_or_different_name_splits(self):
        df = make_intervals([
            (1, "NURI", "1", "2020-06-12 00:00", "2020-06-12 06:00"),
            (2, "NURI", "3", "2020-06-12 07:00", "2020-06-12 12:00"),
            (3, "SAOLA", "8 NE", "2020-06-12 12:00", "2020-06-12 14:00"),
        ])
        self.assertEqual(list(assign_event_ids(df)["event_id"]), ["E01", "E02", "E03"])

    def test_unnamed_records_never_merge(self):
        df = make_intervals([
            (1, "no name", "1", "2021-01-01 00:00", "2021-01-01 06:00"),
            (2, "no name", "1", "2021-01-01 06:00", "2021-01-01 09:00"),
        ])
        self.assertEqual(list(assign_event_ids(df)["event_id"]), ["E01", "E02"])

    def test_workbook_has_136_records_and_44_events(self):
        if not DEFAULT_WORKBOOK.exists():
            self.skipTest("HKO workbook not found")
        intervals = assign_event_ids(read_signal_intervals(DEFAULT_WORKBOOK))
        self.assertEqual(len(intervals), 136)
        self.assertEqual(intervals["event_id"].nunique(), 44)


class HourClassificationTests(unittest.TestCase):
    def test_on_hour_interval_gives_pure_bins(self):
        df = assign_event_ids(make_intervals([
            (1, "NURI", "1", "2020-06-12 00:00", "2020-06-12 03:00"),
        ]))
        bins = classify_hours(df)
        self.assertEqual(list(bins["hour_class"]), ["pure"] * 3)
        self.assertEqual(list(bins["signal_group"]), ["low"] * 3)

    def test_off_hour_boundary_makes_partial_bin_transition(self):
        df = assign_event_ids(make_intervals([
            (1, "NURI", "1", "2020-06-12 00:40", "2020-06-12 03:00"),
        ]))
        bins = classify_hours(df).set_index("bin_start")["hour_class"]
        self.assertEqual(bins[pd.Timestamp("2020-06-12 00:00")], "transition")
        self.assertEqual(bins[pd.Timestamp("2020-06-12 01:00")], "pure")

    def test_overlapping_intervals_make_transition(self):
        df = assign_event_ids(make_intervals([
            (1, "NURI", "1", "2020-06-12 00:00", "2020-06-12 02:00"),
            (2, "SAOLA", "8 NE", "2020-06-12 01:00", "2020-06-12 03:00"),
        ]))
        bins = classify_hours(df).set_index("bin_start")["hour_class"]
        self.assertEqual(bins[pd.Timestamp("2020-06-12 01:00")], "transition")
        self.assertEqual(bins[pd.Timestamp("2020-06-12 00:00")], "pure")

    def test_contiguous_on_hour_handover_keeps_both_hours_pure(self):
        df = assign_event_ids(make_intervals([
            (1, "NURI", "1", "2020-06-12 00:00", "2020-06-12 02:00"),
            (2, "NURI", "3", "2020-06-12 02:00", "2020-06-12 04:00"),
        ]))
        bins = classify_hours(df).set_index("bin_start")
        self.assertEqual(bins.loc[pd.Timestamp("2020-06-12 01:00"), "hour_class"], "pure")
        self.assertEqual(bins.loc[pd.Timestamp("2020-06-12 02:00"), "signal_group"], "low")


class WindowBinTests(unittest.TestCase):
    def test_only_fully_inside_bins_are_returned(self):
        bins = window_bins(pd.Timestamp("2020-06-11 10:30"), pd.Timestamp("2020-06-12 10:30"))
        self.assertEqual(len(bins), 23)
        self.assertEqual(bins[0], pd.Timestamp("2020-06-11 11:00"))
        self.assertEqual(bins[-1], pd.Timestamp("2020-06-12 09:00"))


class BaselineTests(unittest.TestCase):
    def setUp(self):
        self.grid_start = pd.Timestamp("2020-01-01 00:00")
        self.grid_end = pd.Timestamp("2020-12-31 23:00")

    def event(self, event_id, start, end):
        return pd.DataFrame([{
            "event_id": event_id,
            "start_hkt": pd.Timestamp(start),
            "end_hkt": pd.Timestamp(end),
        }])

    def test_full_window_is_full_status(self):
        events = self.event("E01", "2020-01-02 00:00", "2020-01-02 06:00")
        summary, free = build_baseline_tables(
            events, 24, set(), self.grid_start, self.grid_end
        )
        before = summary[summary["side"] == "before"].iloc[0]
        self.assertEqual(before["free_bins"], 24)
        self.assertEqual(before["status"], "full")

    def test_warning_hour_inside_window_reduces_it(self):
        events = self.event("E01", "2020-01-02 00:00", "2020-01-02 06:00")
        touched = {pd.Timestamp("2020-01-01 10:00")}
        summary, _ = build_baseline_tables(events, 24, touched, self.grid_start, self.grid_end)
        before = summary[summary["side"] == "before"].iloc[0]
        self.assertEqual(before["warning_contaminated_bins"], 1)
        self.assertEqual(before["free_bins"], 23)
        self.assertEqual(before["status"], "reduced")

    def test_overlapping_windows_share_bins_and_exclude_them(self):
        events = pd.concat([
            self.event("E01", "2020-01-02 00:00", "2020-01-02 06:00"),
            self.event("E02", "2020-01-02 12:00", "2020-01-02 14:00"),
        ], ignore_index=True)
        summary, _ = build_baseline_tables(events, 24, set(), self.grid_start, self.grid_end)
        e01_before = summary[(summary["event_id"] == "E01") & (summary["side"] == "before")].iloc[0]
        self.assertEqual(e01_before["shared_bins"], 12)
        self.assertEqual(e01_before["free_bins"], 12)
        self.assertEqual(e01_before["status"], "reduced")

    def test_window_below_minimum_is_excluded(self):
        events = self.event("E01", "2020-01-02 00:00", "2020-01-02 06:00")
        summary, free = build_baseline_tables(
            events, 24, set(), pd.Timestamp("2020-01-01 20:00"), self.grid_end
        )
        before = summary[summary["side"] == "before"].iloc[0]
        self.assertEqual(before["status"], "excluded")
        self.assertFalse(((free["event_id"] == "E01") & (free["side"] == "before")).any())

    def _touch_before_window(self, start, n_touched, window_hours):
        """Mark the first n hours of the before window as warning-contaminated."""
        begin = pd.Timestamp(start) - pd.Timedelta(hours=window_hours)
        return {begin + pd.Timedelta(hours=i) for i in range(n_touched)}

    def _before_status(self, window_hours, n_touched):
        events = self.event("E01", "2020-01-10 00:00", "2020-01-10 06:00")
        touched = self._touch_before_window("2020-01-10 00:00", n_touched, window_hours)
        summary, _ = build_baseline_tables(
            events, window_hours, touched, self.grid_start, self.grid_end
        )
        before = summary[summary["side"] == "before"].iloc[0]
        return before["free_bins"], before["status"]

    def test_eleven_free_bins_is_excluded(self):
        # 24 raw bins, 13 touched -> 11 free, below the 12-hour minimum.
        free_bins, status = self._before_status(24, 13)
        self.assertEqual(free_bins, 11)
        self.assertEqual(status, "excluded")

    def test_twelve_free_bins_is_reduced_when_not_all_bins_free(self):
        # 24 raw bins, 12 touched -> 12 free: meets the minimum but is not full.
        free_bins, status = self._before_status(24, 12)
        self.assertEqual(free_bins, 12)
        self.assertEqual(status, "reduced")

    def test_48h_window_status_classification(self):
        # 48 raw bins per window: 0 touched -> full; 36 touched -> 12 free (reduced);
        # 37 touched -> 11 free (excluded).
        self.assertEqual(self._before_status(48, 0), (48, "full"))
        self.assertEqual(self._before_status(48, 36), (12, "reduced"))
        self.assertEqual(self._before_status(48, 37), (11, "excluded"))


class CompletenessAndMedianTests(unittest.TestCase):
    def test_required_valid_uses_exact_ceiling(self):
        self.assertEqual(required_valid(1, 0.75), 2)
        self.assertEqual(required_valid(2, 0.5), 2)
        self.assertEqual(required_valid(4, 0.75), 3)
        self.assertEqual(required_valid(8, 0.75), 6)
        self.assertEqual(required_valid(30, 0.9), 27)

    def test_zero_is_valid_and_nan_is_excluded_from_median(self):
        rows = pd.DataFrame({
            "event_id": ["E01"] * 4,
            "signal_group": ["low"] * 4,
            "station_id": ["A"] * 4,
            "pollutant": ["NO2"] * 4,
            "value": [0.0, 10.0, np.nan, 20.0],
        })
        unit = summarise_units(rows, ["event_id", "signal_group", "station_id", "pollutant"]).iloc[0]
        self.assertEqual(unit["n_eligible"], 4)
        self.assertEqual(unit["n_valid"], 3)
        self.assertEqual(unit["n_zero"], 1)
        self.assertEqual(unit["median"], 10.0)
        self.assertTrue(unit["retained_75"])

    def test_all_missing_unit_is_not_retained(self):
        rows = pd.DataFrame({
            "event_id": ["E01"] * 2,
            "signal_group": ["high"] * 2,
            "station_id": ["A"] * 2,
            "pollutant": ["O3"] * 2,
            "value": [np.nan, np.nan],
        })
        unit = summarise_units(rows, ["event_id", "signal_group", "station_id", "pollutant"]).iloc[0]
        self.assertTrue(np.isnan(unit["median"]))
        self.assertFalse(unit["retained_75"])

    def test_pairs_use_high_minus_low(self):
        units = pd.DataFrame({
            "event_id": ["E01", "E01"],
            "signal_group": ["low", "high"],
            "station_id": ["A", "A"],
            "pollutant": ["RSP", "RSP"],
            "median": [30.0, 45.0],
            "n_valid": [4, 3],
            "retained_75": [True, True],
            "retained_6": [False, True],
        })
        paired = build_pairs(units, "retained_75")
        self.assertEqual(paired["diff_high_minus_low"].iloc[0], 15.0)
        self.assertTrue(build_pairs(units, "retained_6").empty)


class SensitivitySummaryTests(unittest.TestCase):
    def _units(self):
        return pd.DataFrame({
            "retained_75": [True, True, False],
            "retained_6": [True, False, False],
        })

    def test_status_counts_are_reported_separately_and_sum_to_total(self):
        windows = self._windows([
            ("E01", "before", "full"), ("E01", "after", "full"),
            ("E02", "before", "reduced"), ("E02", "after", "excluded"),
            ("E03", "before", "excluded"),
        ])
        row = summarise_variant("window_48h", 0, 48, self._units(), pd.DataFrame(), windows)
        self.assertEqual(row["windows_total"], 5)
        self.assertEqual(row["windows_full"], 2)
        self.assertEqual(row["windows_reduced"], 1)
        self.assertEqual(row["windows_excluded"], 2)
        self.assertEqual(
            row["windows_full"] + row["windows_reduced"] + row["windows_excluded"],
            row["windows_total"],
        )

    def test_zero_reduced_windows_is_reported_as_zero(self):
        windows = self._windows([("E01", "before", "full"), ("E01", "after", "excluded")])
        row = summarise_variant("primary", 0, 24, self._units(), pd.DataFrame(), windows)
        self.assertEqual(row["windows_reduced"], 0)

    def test_unexpected_status_label_raises(self):
        windows = self._windows([("E01", "before", "full"), ("E01", "after", "partial")])
        with self.assertRaises(ValueError):
            summarise_variant("primary", 0, 24, self._units(), pd.DataFrame(), windows)

    def test_retained_and_pair_counts(self):
        pairs = pd.DataFrame({
            "event_id": ["E01", "E01", "E02"],
            "station_id": ["A", "B", "A"],
        })
        windows = self._windows([("E01", "before", "full"), ("E01", "after", "full")])
        row = summarise_variant("primary", 0, 24, self._units(), pairs, windows)
        self.assertEqual(row["units_total"], 3)
        self.assertEqual(row["units_retained_75"], 2)
        self.assertEqual(row["units_retained_6"], 1)
        self.assertEqual(row["paired_triples_75"], 3)
        self.assertEqual(row["paired_events_75"], 2)
        self.assertEqual(row["paired_stations_75"], 2)

    def _windows(self, rows):
        return pd.DataFrame(rows, columns=["event_id", "side", "status"])

    def test_only_events_with_both_sides_full_are_eligible(self):
        windows = self._windows([
            ("E01", "before", "full"), ("E01", "after", "full"),      # both full: eligible
            ("E02", "before", "full"), ("E02", "after", "reduced"),   # after not full
            ("E03", "before", "excluded"), ("E03", "after", "full"),  # before excluded
            ("E04", "before", "full"),                                # after window missing
        ])
        self.assertEqual(full_window_event_ids(windows), {"E01"})

    def test_restrict_removes_units_from_one_sided_events(self):
        windows = self._windows([
            ("E01", "before", "full"), ("E01", "after", "full"),
            ("E02", "before", "full"), ("E02", "after", "reduced"),
        ])
        units = pd.DataFrame({
            "event_id": ["E01", "E01", "E02", "E02"],
            "signal_group": ["low", "high", "low", "high"],
            "station_id": ["A", "A", "A", "A"],
            "pollutant": ["RSP", "RSP", "RSP", "RSP"],
            "median": [30.0, 45.0, 20.0, 60.0],
            "n_valid": [4, 4, 4, 4],
            "retained_75": [True, True, True, True],
            "retained_6": [True, True, True, True],
        })
        restricted = restrict_to_full_windows(units, windows)
        self.assertEqual(set(restricted["event_id"]), {"E01"})
        paired = build_pairs(restricted, "retained_75")
        self.assertEqual(len(paired), 1)
        self.assertEqual(paired["event_id"].iloc[0], "E01")

    def test_role_and_eligible_events_are_reported(self):
        windows = self._windows([
            ("E01", "before", "full"), ("E01", "after", "full"),
            ("E02", "before", "full"), ("E02", "after", "reduced"),
        ])
        pairs = pd.DataFrame({"event_id": ["E01"], "station_id": ["A"]})
        row = summarise_variant(
            "window_48h_full_only", 0, 48, self._units(), pairs, windows, True,
            role="sensitivity_48h_full_windows_only",
        )
        self.assertEqual(row["role"], "sensitivity_48h_full_windows_only")
        self.assertEqual(row["eligible_events"], 1)
        self.assertEqual(row["paired_events_75"], 1)

    def test_eligible_events_can_exceed_paired_events(self):
        windows = self._windows([
            ("E01", "before", "full"), ("E01", "after", "full"),
            ("E02", "before", "full"), ("E02", "after", "full"),
        ])
        pairs = pd.DataFrame({"event_id": ["E01"], "station_id": ["A"]})
        row = summarise_variant("primary", 0, 24, self._units(), pairs, windows)
        self.assertEqual(row["eligible_events"], 2)
        self.assertEqual(row["paired_events_75"], 1)

    def test_full_only_flag_is_reported(self):
        windows = self._windows([("E01", "before", "full"), ("E01", "after", "full")])
        row = summarise_variant("window_48h_full_only", 0, 48, self._units(), pd.DataFrame(), windows, True)
        self.assertTrue(row["full_windows_only"])
        row = summarise_variant("primary", 0, 24, self._units(), pd.DataFrame(), windows)
        self.assertFalse(row["full_windows_only"])


if __name__ == "__main__":
    unittest.main()
