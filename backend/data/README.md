# MHT-CET historical cutoff data

The supplied CSV files are kept unchanged in `raw/`. The reproducible processor writes `processed/mhtcet_dataset.json` and `reports/mhtcet_data_quality.json`; rerunning it replaces those generated outputs instead of appending duplicate rows.

## Supplied data and limitations

- `mhcap_reference.csv` describes seat types, categories, and CAP flow.
- `maharashtra_colleges_mhtcet.csv` is a partial college/city reference list, not a complete CAP institute directory.
- `mhtcet_2026_cutoffs_partial.csv` contains 134 records for 2026 CAP rounds 3 and 4, only `General/Open`, and marks every row `secondary_unverified`.
- `Indian_Engineering_Colleges_Dataset.csv` supplies the Explore & Apply directory. All 732 rows are preserved, including repeated college names. It includes states, fee values, and rating fields, but does not supply courses, city, official links, fee currency, or billing period.
- No supplied cutoff rows are labeled as verified official data. The source URL is retained on each row.
- The reference's S, H, O, AI, and MI descriptions are retained as reference values; they are not mapped to cutoff `seat_level` values.
- The reference identifies All India seats as JEE Main rank based. MHT-CET ranks are therefore compared only with cutoff rows whose supplied `seat_level` is exactly `State`.
- College and branch display names are preserved. Normalized text is used only for matching/filtering; unmatched or ambiguous city references remain unavailable.
- Percentiles are not converted to ranks. No admission probabilities are calculated and no model is trained.

## Processing and report

From `backend/`, run:

```powershell
python -m app.mhtcet.pipeline
```

The processor normalizes column names and whitespace, preserves the raw input files and source values, validates closing ranks, reports exact duplicates and repeated comparison keys, and records the available years, rounds, categories, seat levels, rank range, source URLs, data-quality labels, and city matches. Explore & Apply displays the college dataset values as supplied; its fee currency and billing period are intentionally not inferred.

Exact duplicate rows are reported and only exact duplicates are removed from the processed output. Distinct round/category/seat-level rows are retained.

## API

Both routes require a bearer token for a student account:

- `GET /api/recommendations/mhtcet/options` returns data-driven filter values.
- `POST /api/recommendations/mhtcet` compares a rank with matching historical records.

Example request:

```json
{
  "rank": 12000,
  "branch": "Computer Engineering",
  "city": "Mumbai",
  "category": "General/Open",
  "cap_round": 4,
  "seat_level": "State"
}
```

Branch, city, CAP round, and seat level are optional in the request; category and positive integer rank are required. The endpoint returns `within_historical_cutoff`, `outside_historical_cutoff`, or an `insufficient_data` response, together with the closing rank, year, round, source URL, and verification label. A percentile input is intentionally unsupported until a validated rank conversion dataset exists.

## Adding and verifying future cutoff data

1. Keep each received source file in `raw/` with a distinct filename and preserve its source URL and provenance.
2. Update the isolated MHT-CET processor's input configuration/schema if columns differ; do not infer category or seat-pool equivalence.
3. Add a focused test fixture for new columns, missing values, and duplicate keys.
4. Confirm the issuing authority, year, CAP round, category, seat pool, rank basis, and source URL before labeling any data verified.
5. Regenerate the processed file and quality report, review both, and run `pytest -q tests/test_mhtcet.py`.

The current secondary source and partial records do not establish official or complete admissions cutoffs. Recommendations are historical comparisons only and never guarantee admission.
