import unittest

import numpy as np
import pandas as pd

from scripts.story2_analysis import (
    build_city_profile,
    build_station_hour_differences,
    build_station_hour_profiles,
    build_station_summary,
    dedupe_observations,
    expected_days,
)


def make_obs(rows):
    """rows: (station_id, datetime string, value)."""
    return pd.DataFrame(
        [{"station_id": s, "dt": pd.Timestamp(t), "value": v} for s, t, v in rows]
    )


def cell(prof, station, hour, day_type):
    row = prof[(prof.station_id == station) & (prof.hour == hour) & (prof.day_type == day_type)]
    assert len(row) == 1
    return row.iloc[0]


class ExpectedDaysTests(unittest.TestCase):
    def test_week_counts_mon_to_thu(self):
        # 2020-01-06 is a Monday; Mon-Thu holds four weekdays and no weekend days.
        self.assertEqual(
            expected_days(pd.Timestamp("2020-01-06"), pd.Timestamp("2020-01-09")),
            {"weekday": 4, "weekend": 0},
        )

    def test_full_week_counts(self):
        self.assertEqual(
            expected_days(pd.Timestamp("2020-01-06"), pd.Timestamp("2020-01-12")),
            {"weekday": 5, "weekend": 2},
        )


class DedupeTests(unittest.TestCase):
    def test_exact_duplicates_collapsed_and_conflicts_dropped(self):
        obs = make_obs([
            ("A", "2020-01-06 00:00", 10.0),
            ("A", "2020-01-06 00:00", 10.0),
            ("A", "2020-01-06 01:00", 5.0),
            ("A", "2020-01-06 01:00", 7.0),
        ])
        out, stats = dedupe_observations(obs)
        self.assertEqual(len(out), 1)
        self.assertEqual(out.iloc[0]["value"], 10.0)
        self.assertEqual(stats["exact_duplicate_rows_dropped"], 1)
        self.assertEqual(stats["conflicting_keys_dropped"], 1)
        self.assertEqual(stats["conflicting_rows_dropped"], 2)


class MissingAndZeroTests(unittest.TestCase):
    def test_zero_is_valid_and_nan_is_excluded_not_zero(self):
        # Four weekdays (Mon-Thu) at hour 0: two zeros and two valid values at 20 and 40.
        obs = make_obs([
            ("A", "2020-01-06 00:00", 0.0),
            ("A", "2020-01-07 00:00", 20.0),
            ("A", "2020-01-08 00:00", 40.0),
            ("A", "2020-01-09 00:00", 0.0),
        ])
        prof = build_station_hour_profiles(obs)
        c = cell(prof, "A", 0, "weekday")
        self.assertEqual(c.valid_obs, 4)
        self.assertAlmostEqual(c.mean_no2, 15.0)
        self.assertTrue(c.qualifies)

    def test_nan_rows_never_reach_profiles(self):
        obs = make_obs([("A", "2020-01-06 00:00", 10.0)])
        obs.loc[len(obs)] = {"station_id": "A", "dt": pd.Timestamp("2020-01-07 00:00"), "value": np.nan}
        obs = obs.dropna(subset=["value"])
        prof = build_station_hour_profiles(obs)
        self.assertEqual(cell(prof, "A", 0, "weekday").valid_obs, 1)


class CoverageThresholdTests(unittest.TestCase):
    def _station(self, valid_days):
        # Four weekdays expected (Mon-Thu); also one weekend day so the span is realistic.
        rows = [("A", f"2020-01-{6 + i:02d} 00:00", 10.0) for i in range(valid_days)]
        rows.append(("A", "2020-01-09 12:00", 1.0))  # keeps the span to Thursday
        return make_obs(rows)

    def test_exactly_fifty_percent_qualifies(self):
        prof = build_station_hour_profiles(self._station(valid_days=2))
        c = cell(prof, "A", 0, "weekday")
        self.assertEqual(c.expected_days, 4)
        self.assertAlmostEqual(c.coverage_pct, 0.5)
        self.assertTrue(c.qualifies)
        self.assertAlmostEqual(c.mean_no2, 10.0)

    def test_below_fifty_percent_is_blank(self):
        prof = build_station_hour_profiles(self._station(valid_days=1))
        c = cell(prof, "A", 0, "weekday")
        self.assertFalse(c.qualifies)
        self.assertTrue(np.isnan(c.mean_no2))
        self.assertEqual(c.valid_obs, 1)

    def test_missing_hours_appear_with_zero_counts(self):
        prof = build_station_hour_profiles(self._station(valid_days=2))
        c = cell(prof, "A", 23, "weekday")
        self.assertEqual(c.valid_obs, 0)
        self.assertFalse(c.qualifies)


class CityProfileTests(unittest.TestCase):
    def test_city_requires_minimum_qualifying_stations(self):
        rows = []
        for s, v in [("A", 10.0), ("B", 20.0)]:
            rows += [(s, f"2020-01-{6 + i:02d} 00:00", v) for i in range(4)]
        prof = build_station_hour_profiles(make_obs(rows))
        city = build_city_profile(prof)
        row = city[(city.hour == 0) & (city.day_type == "weekday")].iloc[0]
        self.assertEqual(row.n_stations, 2)
        self.assertTrue(np.isnan(row.median_no2))


class DifferenceTests(unittest.TestCase):
    def test_differences_only_where_both_day_types_qualify(self):
        rows = []
        # Weekdays Mon-Thu, hour 0 valid on all four days (qualifies).
        rows += [("A", f"2020-01-{6 + i:02d} 00:00", 30.0) for i in range(4)]
        # Weekend day Sat 2020-01-11 only, one day out of two expected (qualifies at 50%).
        rows += [("A", "2020-01-11 00:00", 20.0), ("A", "2020-01-12 00:00", 99.0)]
        # Hour 1: weekdays valid, weekend absent (no weekend pair).
        rows += [("A", f"2020-01-{6 + i:02d} 01:00", 5.0) for i in range(4)]
        prof = build_station_hour_profiles(make_obs(rows))
        diffs = build_station_hour_differences(prof)
        self.assertEqual(set(diffs.hour), {0})
        self.assertAlmostEqual(diffs.iloc[0]["difference"], 30.0 - 59.5)

    def test_one_sided_full_window_is_not_paired(self):
        rows = [("A", f"2020-01-{6 + i:02d} 00:00", 30.0) for i in range(4)]
        prof = build_station_hour_profiles(make_obs(rows))
        self.assertTrue(build_station_hour_differences(prof).empty)


class StationSummaryTests(unittest.TestCase):
    def test_peak_uses_only_qualifying_hours_and_flags_name_overlap(self):
        rows = []
        rows += [("CENTRAL", f"2020-01-{6 + i:02d} 18:00", 50.0) for i in range(4)]
        rows += [("CENTRAL", f"2020-01-{6 + i:02d} 08:00", 60.0) for i in range(1)]  # not qualifying
        rows += [("CENTRAL/WESTERN", f"2020-01-{6 + i:02d} 18:00", 40.0) for i in range(4)]
        deduped = make_obs(rows)
        prof = build_station_hour_profiles(deduped)
        summary = build_station_summary(prof, deduped).set_index("station_id")
        self.assertEqual(summary.loc["CENTRAL", "weekday_peak_hour"], 18)
        self.assertTrue(summary.loc["CENTRAL", "name_overlap_flag"])
        self.assertTrue(summary.loc["CENTRAL/WESTERN", "name_overlap_flag"])
        self.assertIn("kept as a distinct series", summary.loc["CENTRAL", "review_note"])


if __name__ == "__main__":
    unittest.main()
