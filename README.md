# A Spatial-Temporal Data Storytelling Platform for Hong Kong Air Pollution

This repository contains a staged implementation for an FYP data-storytelling platform that combines data preprocessing (Python/Pandas) and a scroll-driven web frontend (HTML/CSS/JS with Plotly + Leaflet).

## Project architecture

- `scripts/data_inventory.py`: recursively inspects expected data folders, detects CSV header rows (including prefixed metadata lines), profiles schema/coverage/quality, and generates an inventory.
- `scripts/preprocess.py`: builds cleaned and analysis-ready files for the three stories using available air-quality files.
- `web/`: scrollytelling frontend using Intersection Observer, Plotly.js, and Leaflet.
- `output/`: generated inventory and analysis outputs (kept separate from raw data).
- `tests/`: focused parsing tests.

## Expected data folders

Place datasets in repository root folders:

- `Air Quality`
- `Average relative humidity`
- `average temperature`
- `Average wind direction, average wind ...`
- `Impact of Tropical Cyclones`
- `Total daily rainfall`
- `Traffic flow`

Raw files are never overwritten by scripts.

## Setup and run

```bash
python -m pip install -r requirements.txt
python scripts/data_inventory.py
python scripts/preprocess.py
python -m http.server 8000
```

Open: `http://localhost:8000/web/`

## Data outputs

Inventory outputs:

- `output/analysis/data_inventory.csv`
- `output/analysis/data_inventory.md`
- `output/analysis/join_compatibility.json`
- `output/analysis/inventory_summary.json`

Preprocessing outputs (when data is available):

- `output/clean/air_quality_long.csv`
- `output/analysis/story1_doksuri_window.csv`
- `output/analysis/story2_no2_hourly_profiles.csv`
- `output/analysis/story3_daily_summary.csv`
- `output/analysis/story3_monthly_summary.csv`
- `output/analysis/story3_seasonal_summary.csv`
- `output/analysis/preprocess_report.json`

## Story sections implemented

1. **Tropical Cyclones and Extreme Haze** (event window chart for 24–29 Jul 2023)
2. **Traffic Flow and Roadside NO2 Patterns** (hourly weekday/weekend NO2 profile)
3. **Seasonal Air Quality in Hong Kong** (seasonal aggregated bars)

Each story updates the persistent visualization panel using Intersection Observer as users scroll.

## Analytical definitions and limitations

- Seasons used in preprocessing: winter (Dec–Feb), spring (Mar–May), summer (Jun–Aug), autumn (Sep–Nov).
- Missing values are preserved as missing (never replaced with zero).
- Dataset joins are recommended only when date/time granularity and station/location identifiers are compatible.
- If folders/files are missing or incompatible, scripts write explicit limitations to output reports and the frontend displays placeholders instead of fabricated results.

## Testing

Run focused tests:

```bash
python -m pytest tests/test_common.py
```

## Implementation workflow status

This implementation supports staged execution:

1. Data inspection and preprocessing scripts.
2. Initial dashboard + interaction scaffolding.
3. Story 1 visual transition.
4. Story 2 and 3 transitions.
5. Scroll-driven responsive styling.
6. Documentation and validation commands.

To deepen analysis, add verified station coordinates, tropical cyclone event datasets, weather files, and traffic files with compatible timestamps/locations.
