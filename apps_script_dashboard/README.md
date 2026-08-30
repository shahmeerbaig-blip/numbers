# Qatar Refund Fraud Signals — Apps Script dashboard

Three files, paste directly into a Google Apps Script project:

- `Code.gs` — runs the two SQL rules live against BigQuery, parameterized by the toggles below.
- `Index.html` — the dashboard UI (filters, stat tiles, charts, sortable tables).
- `appsscript.json` — manifest (BigQuery advanced service + web app config).

## Setup

1. [script.google.com](https://script.google.com) → New project.
2. Replace the default `Code.gs` with this repo's `Code.gs`.
3. File → New → HTML file → name it `Index` → paste this repo's `Index.html`.
4. Project Settings → check "Show `appsscript.json` manifest file in editor" →
   open it → replace its contents with this repo's `appsscript.json`.
5. In `Code.gs`, confirm `BILLING_PROJECT` (`tlb-data-dev`) is a project your
   Google account has `bigquery.jobs.create` on — this is the same project
   used to validate both queries during development, since neither
   `fulfillment-dwh-production` nor `tlb-data-prod` grants job-create
   directly.
6. Deploy → New deployment → type "Web app". Execute as **User accessing the
   web app** (so BigQuery runs under each viewer's own credentials/quota,
   not yours) and set access to whoever should see this.
7. Open the deployed URL. First run will prompt for OAuth consent
   (BigQuery read-only scope).

Each viewer needs read access to `fulfillment-dwh-production.curated_data_shared`
and job-create on `tlb-data-dev` — the same access already confirmed while
building `location_change_delay_refund_pattern.sql` and
`customer_repeat_refund_risk_score.sql`.

## Toggles on the dashboard

| Toggle | Scope | Default | What it does |
|---|---|---|---|
| Date range (7/30/90/180 days, or custom) | Both sections | 30 days | Trailing window both queries scan (`created_date >=` cutoff) |
| Min pin shift (meters) | Location-change section | 500m | How far the dropoff pin must move between dispatch and delivery to count as a location change |
| Min delay (minutes) | Location-change section | 5 min | Minimum delivery delay required alongside the pin shift |
| Min claims to qualify | Risk-score section | 3 | Minimum trailing claim count for a customer to appear at all |
| Risk tiers shown (HIGH/MEDIUM/LOW checkboxes) | Risk-score section | all checked | Client-side filter on the already-fetched result — no requery |

Changing date range, pin shift, delay, or min-claims triggers a live BigQuery
query (each scans a few GB), so they fire on blur/change rather than on every
keystroke. Risk-tier checkboxes just re-filter data already in memory.

## Notes

- Both queries are Qatar-only, matching `location_change_delay_refund_pattern.sql`
  and `customer_repeat_refund_risk_score.sql` in the repo root — this dashboard
  doesn't add a country toggle on top of that.
- All SQL inputs from the UI go through named BigQuery query parameters
  (`@days_back`, `@min_shift_meters`, ...), never string concatenation, so the
  toggles can't be turned into SQL injection.
- The two source `.sql` files in the repo root are the canonical, reviewable
  version of these rules — the queries embedded in `Code.gs` are the same
  logic, just parameterized.
