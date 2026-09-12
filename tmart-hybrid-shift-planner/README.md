# TMart Hybrid Shift Planner

A Google Apps Script web app that pulls hourly order demand and Hybrid
rider supply from BigQuery for TMart darkstore branches, and lets you
plan shift windows and rider counts per branch.

## Files

- `Code.gs` — backend: runs the BigQuery query, caches results, serves the page.
- `index.html` — frontend: sidebar controls, charts, and the shift-plan table.

## Deploy (one-time setup, ~2 minutes)

There is no Apps Script API connector available in this session, so this
project can't be provisioned automatically — create it by hand:

1. Go to [script.google.com/create](https://script.google.com/create) (or,
   from a Google Sheet/Doc, Extensions → Apps Script, if you want it bound
   to a spreadsheet instead of standalone).
2. Delete the default `Code.gs` boilerplate and paste in this repo's `Code.gs`.
3. Add an HTML file: the `+` next to "Files" → HTML → name it exactly `index`
   (matches `HtmlService.createHtmlOutputFromFile('index')` in `Code.gs`).
   Paste in this repo's `index.html`.
4. Enable the BigQuery advanced service: left sidebar → Services → `+` →
   select **BigQuery API** → Add. (This is what makes `BigQuery.Jobs.query`
   available to `Code.gs`.)
5. In Google Cloud, make sure whichever account owns this script has BigQuery
   read access to `tlb-data-prod.data_platform.*` under the project set in
   `PROJECT_ID` (`tlb-nondatateam-analysis-9264` — change this constant in
   `Code.gs` if you're running under a different GCP project).
6. Deploy → New deployment → type: **Web app** → execute as **Me**, who has
   access: whoever needs to use the dashboard → Deploy. Open the resulting URL.

## Known limitations

- `distance_cap_lookup` in the BigQuery query and `DEFAULT_DIST_CAP` in
  `index.html` are hardcoded per-branch Hybrid dropoff-distance caps (km),
  not read from `hybrid_fleet_distance_cap_2` — that table lives in
  `tlb-data-dev.data_platform_logistics` and was Access Denied when this was
  built. If you get access to that dataset later, both lookups should be
  swapped for a live join/fetch instead of the hardcoded list — otherwise a
  new or renamed branch won't get its cap applied until someone updates both
  places by hand.
- A branch not in that hardcoded cap list is treated as **uncapped**
  (included without distance filtering), not dropped from the dashboard.
- `active_riders` counts Hybrid-contract riders on shift
  (`fct_logistics_rider_shift`, actual clock-in/out), attributed to whichever
  branch they had the most completed orders at that day — there's no direct
  rider-shift-to-branch mapping in the source data.
