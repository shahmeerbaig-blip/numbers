# Tmart Hybrid Performance — Live Dashboard (Apps Script draft)

Draft Apps Script web app that reads live from the **"Tmart Hybrid
Performance - Daily Report"** Google Sheet and renders three sections:
**Daily Order Count and Summary**, **Rider UTR**, and **Return to Vendor
Violation**.

This version is matched against the real tabs in that sheet (confirmed by
reading its content directly), not generic placeholders:

| Dashboard section | Real tab | What it reads |
|---|---|---|
| Daily Order Count and Summary | `Daily Order Count and Summary` | The `SUM of order_count` pivot (Hybrid Fleet / Shared Fleet / Total TMart Orders by day) + the `Active Rider Count` pivot, summed across all vendors |
| Rider UTR | `RIDER UTR` | The `CAR UTR` and `BIKE` per-rider pivots, averaged per day across all riders with orders that day (0.00 = no orders, excluded from the average) |
| Return to Vendor Violation | `Return to Vendor Violations` | The flat list of flagged rider gaps, grouped by `order_date`; a row counts as a violation unless its `status` is `ON_BREAK` or `SHIFT_ENDED` (excused) |

## Why it reads pivots by label, not by fixed range

`Daily Order Count and Summary` and `RIDER UTR` are native Google Sheets
**Pivot Tables** stacked in one tab. Their row order and date-column count
shift every day (new dates get added, vendors/riders come and go), so a
fixed range like `A1:F60` breaks within days. Instead, `Code.gs` has
`findPivotBlockAuto_()`, which:

1. Scans column A for the exact label Sheets writes in a pivot's corner
   cell (e.g. `SUM of order_count`, `Active Rider Count`, `CAR UTR`).
2. Looks up to 4 rows below that for the real header row — the first one
   whose column B looks like a date — since some pivots have an extra
   auto-generated title row (`Rider Count,order_date`) in between.
3. Reads until the first blank row in column A.

If you rename a pivot's value field (so its corner-cell label changes) or
add a new one, update the matching anchor string in `CONFIG` in `Code.gs`.

## Date range selector

A `7D / 14D / 30D / All` control sits above the sections (default `30D`,
matching `DEFAULT_RANGE_DAYS` in `Code.gs`). It's passed as `days` into
`getDashboardData(days)` / `forceRefreshDashboardData(days)`, and
`decorateSection_()` trims each series to that trailing window (based on
that series' own latest date, so mismatched pivot date ranges each trim
correctly) before computing KPIs — so "avg / total" on the tiles reflects
the selected range too, not just the chart.

Note this doesn't shrink the underlying sheet *read* for
`Return to Vendor Violations`, since those rows aren't sorted by date (they
come in sorted by gap size), so a bounded read isn't possible without first
reading everything. It does shrink the response payload and render cost.
As that sheet grows past a comfortable read size, the next real fix would
be on the sheet side — e.g. having the query that populates that tab only
look back N days — rather than something Apps Script can do after the fact.

## Performance

Each `SpreadsheetApp` call has fixed round-trip latency on top of the data
it moves, so call *count* matters as much as row count:

- `getColumnA_()` reads column A once per sheet and is reused across every
  `findPivotBlockAuto_()` / `findRowByFirstCell_()` call on that sheet
  within one request (e.g. `SUM of order_count` and `Active Rider Count`
  both live on `Daily Order Count and Summary` and now share one read).
- The header-row lookahead (checking up to 4 rows below a pivot's anchor
  for the first date-like cell) is one batched range read instead of up to
  5 separate single-cell reads.
- `Return to Vendor Violations` is still read in full each time (see the
  date range selector note above for why) — as of this writing it's ~5,600
  rows across 7 days (~800/day) and growing, so if load times creep back up
  as more days accumulate, that read is where to look next.

## Known gap: "Return to Vendor Violation" has no confirmed/final status yet

As of when this was built, every row in `Return to Vendor Violations` has
`vendor = "PENDING_LOCATION"` — none have gone through the location check
that would confirm them as an actual violation (there's a
`Return to Vendor - Location Checks` tab that looks like it's meant to hold
that outcome, but it's currently empty). So "violation" here means *any
flagged gap not excused by an on-break or shift-ended status* — it's a
leading indicator, not a confirmed count. Once the location-check tab is
populated, tell me and I'll switch the count to read confirmed violations
from there instead.

## Setup

1. Open the target Google Sheet → **Extensions → Apps Script**.
2. Create a script file named `Code.gs` and paste in this folder's `Code.gs`.
3. Create an HTML file named `index.html` (**File → New → HTML**) and paste
   in this folder's `index.html`.
4. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: whoever should see it
5. Open the deployment URL. **Refresh now** bypasses the 60s cache for the
   currently-selected date range; it also auto-refreshes every 5 minutes.
6. After editing the script, use **Deploy → Manage deployments → Edit →
   New version** so the live URL picks up the change.

## Structure

- `Code.gs`: one section builder per dashboard section
  (`buildOrderSummary_`, `buildRiderUtr_`, `buildRtvViolation_`), each
  returning `{ title, series: [{ name, dateLabels, values }] }`. A shared
  `decorateSection_()` computes latest/average/total (+ optional compliance
  status) per series. Each section is wrapped in its own try/catch, so a
  broken sheet/anchor shows an error banner in that card only.
- `index.html`: renders one KPI tile + one small trend chart per series
  (small multiples), so mismatched date ranges between pivots (e.g. the
  order-count pivot currently spans 22 days, the active-rider pivot spans
  12) are never forced onto a shared axis. Each series has a collapsible
  raw data table.
- Colors follow Talabat's dataviz method: one validated blue for every line
  series, and the reserved good/warning/critical palette for the Violation
  Rate % status dot — never reused for anything else.

## Adjustable bits

- `CONFIG.rtvExcusedStatuses` in `Code.gs` — currently `['ON_BREAK',
  'SHIFT_ENDED']`. Add more statuses here if new excused categories show up.
- `TARGETS.rtvViolation['Violation Rate %']` — warning at 3%, critical at
  5%, lower-is-better. Add targets for other series (e.g. UTR) the same way.
- `CONFIG.refreshCacheSeconds` — 60s by default; set to 0 for always-live
  reads (slower on busy pivots) or raise it if the sheet is heavy.
