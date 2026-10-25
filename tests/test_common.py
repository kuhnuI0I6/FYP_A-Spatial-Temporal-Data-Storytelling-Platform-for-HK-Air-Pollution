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
                "DATE,HOUR,STATION,NO2,O3,RSP,FSP\n"
                "2023-07-24,01,Central,32,10,20,8\n",
                encoding="utf-8",
            )
            self.assertEqual(detect_csv_header_row(sample), 2)

    def test_detect_csv_header_row_with_raw_file_metadata(self):
        with TemporaryDirectory() as td:
            sample = Path(td) / "raw.csv"
            metadata = "".join(f"Remarks {i}\n" for i in range(1, 12))
            sample.write_text(
                metadata
                + "DATE,HOUR,STATION,SO2,NOX,NO2,CO,RSP,O3,FSP\n"
                + "1/1/2023,01,CAUSEWAY BAY,5,253,91,87,40,10,26\n",
                encoding="utf-8",
            )
            self.assertEqual(detect_csv_header_row(sample), 11)


if __name__ == "__main__":
    unittest.main()
