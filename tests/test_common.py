import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.common import detect_csv_header_row


class TestCommon(unittest.TestCase):
    def test_detect_csv_header_row_with_intro_metadata(self):
        with TemporaryDirectory() as td:
            sample = Path(td) / "sample.csv"
            sample.write_text(
                "This file is provided by EPD\n"
                "Updated: 2026-01-01\n"
                "Date,Station,NO2\n"
                "2023-07-24,Central,32\n",
                encoding="utf-8",
            )
            self.assertEqual(detect_csv_header_row(sample), 2)


if __name__ == "__main__":
    unittest.main()
