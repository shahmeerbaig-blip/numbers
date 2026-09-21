# Tmart Hybrid Performance — Live Dashboard (Apps Script draft)

Draft Apps Script web app that reads live from the "Tmart Hybrid Performance -
Daily Report" Google Sheet (or wherever your SQL-connected tabs live) and
renders three sections: **Daily Order Count and Summary**, **Rider UTR**, and
**Return to Vendor Violation**.

This is a starting draft, not a finished mapping to your exact tabs — the
column/sheet names below are placeholders. It's built to fail loudly and
per-section (a wrong sheet/column name shows an error banner in that card
only) rather than crash the whole page, so it's safe to iterate on.

## Setup

1. Open the target Google Sheet → **Extensions → Apps Script**.
2. Create a script file named `Code.gs` and paste in this folder's `Code.gs`
   (replacing the default content).
3. Create an HTML file named `index.html` (**File → New → HTML**) and paste
   in this folder's `index.html`.
4. In `Code.gs`, edit the `CONFIG.sections` block:
   - `sheetName`: the exact tab name for that section's data.
   - `range`: the range covering the header row + all data rows (e.g.
     `A1:F60`).
   - `dateCol` / `valueCols`: must match the header text in row 1 exactly.
   - `targets` (optional, currently only set on Violation Rate %): warning /
     critical thresholds that color that KPI tile's status dot.
5. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: whoever should see it (e.g. anyone within your org)
6. Open the deployment URL. Click **Refresh now** to bypass the 60s cache at
   any time; it also auto-refreshes every 5 minutes.
7. After editing the script, use **Deploy → Manage deployments → Edit →
   New version** so the live URL picks up the change.

## How it's structured

- `Code.gs` has one generic `readTable_()` that turns any sheet range into
  rows of `{ header: value }` objects, and `computeKpis_()` that derives
  latest/average/total (+ optional status) per numeric column. Adding a
  fourth section is just another entry in `CONFIG.sections`.
- `index.html` renders one KPI tile + one small line chart per configured
  column (small multiples), so it never needs a dual-axis chart even if a
  section mixes counts and percentages. Each section has a collapsible raw
  data table for accessibility/verification.
- Colors follow Talabat's dataviz method: a single validated blue for all
  line series, and the reserved good/warning/critical palette for compliance
  status dots — never reused for anything else.

## Known gaps to adjust

- The exact tab names/ranges/column headers for all three sections are
  placeholders — update `CONFIG` to match your sheet.
- No target thresholds are set yet for Order Summary or Rider UTR sections;
  add to `targets` if you want status coloring there too.
- If a section's raw sheet is instead a BigQuery-connected pivot table, the
  header row must still be plain text (not a pivot table's blended header) —
  point `range` at a single clean header + data row block, or add a helper
  tab that flattens the pivot into that shape.
