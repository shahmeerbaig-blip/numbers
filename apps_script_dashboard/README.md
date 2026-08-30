# Talabat Trust & Safety — Qatar Refund/Fraud Signals dashboard

Three files, paste directly into a Google Apps Script project:

- `Code.gs` — runs three rules live against BigQuery, parameterized by the toggles below.
- `Index.html` — the Talabat-themed dashboard UI (filters, stat tiles, charts, sortable/selectable tables, CSV export).
- `appsscript.json` — manifest (BigQuery advanced service + web app config).

## Setup

1. [script.google.com](https://script.google.com) → New project.
2. Replace the default `Code.gs` with this repo's `Code.gs`.
3. File → New → HTML file → name it `Index` → paste this repo's `Index.html`.
4. Project Settings → check "Show `appsscript.json` manifest file in editor" →
   open it → replace its contents with this repo's `appsscript.json`.
5. In `Code.gs`, confirm `BILLING_PROJECT` (`tlb-data-dev`) is a project your
   Google account has `bigquery.jobs.create` on — this is the same project
   used to validate all three queries during development, since neither
   `fulfillment-dwh-production` nor `tlb-data-prod` grants job-create
   directly.
6. Deploy → New deployment → type "Web app". Execute as **User accessing the
   web app** (so BigQuery runs under each viewer's own credentials/quota,
   not yours) and set access to whoever should see this.
7. Open the deployed URL. First run will prompt for OAuth consent
   (BigQuery read-only scope).

Each viewer needs read access to `fulfillment-dwh-production.curated_data_shared`,
`tlb-data-prod.data_platform` (for the fraud/identity tables), and job-create
on `tlb-data-dev`.

## The three sections

1. **Location change → delay → refund** (`location_change_delay_refund_pattern.sql`) —
   orders where the dropoff pin shifted, the delivery was delayed, and a
   late/wrong-address claim followed.
2. **Repeat-offender risk score** (`customer_repeat_refund_risk_score.sql`) —
   customers ranked 0–100 on trailing claim frequency + EUR value.
3. **Fraud network** (new, dashboard-only — no standalone `.sql` file yet) —
   active (not-yet-blocked) accounts already linked by Shield to a
   confirmed-fraud account via shared device ID or mobile number
   (`agg_customer_braze_fraud_flag.network_shield_fraud_account_count`).
   This is the answer to "customer gets blocked, makes a new account, keeps
   going" — we tested doing this by matching shared dropoff GPS coordinates
   instead and it was too noisy to ship (46,935 Qatar locations shared by a
   blocked + an active customer over 180 days, almost all apartment
   buildings). Device/mobile linkage is Shield's own existing, accurate
   version of the same idea.

Every section already filters down to flagged/violating rows only — none of
them pull the full customer or order base.

## Toggles on the dashboard

| Toggle | Scope | Default | What it does |
|---|---|---|---|
| Date range (7/30/90/180 days, or custom) | Sections 1 & 2 | 30 days | Trailing window both queries scan (`created_date >=` cutoff) |
| Min pin shift (meters) | Section 1 | 500m | How far the dropoff pin must move between dispatch and delivery to count as a location change |
| Min delay (minutes) | Section 1 | 5 min | Minimum delivery delay required alongside the pin shift |
| Min claims to qualify | Section 2 | 3 | Minimum trailing claim count for a customer to appear at all |
| Risk tiers shown (HIGH/MEDIUM/LOW checkboxes) | Section 2 | all checked | Client-side filter on the already-fetched result — no requery |
| Min linked fraud accounts | Section 3 | 1 | Minimum Shield-linked confirmed-fraud accounts (by device/mobile) before an active account is surfaced |

Changing date range, pin shift, delay, min-claims, or min-linked-fraud
triggers a live BigQuery query, so they fire on blur/change rather than on
every keystroke. Risk-tier checkboxes just re-filter data already in memory.

## Customer ID and exporting for a block request

Every table's identity column shows Talabat's standard **analytical_customer_id**
(resolved live via `rltnp_account_x_identifiers`) as the primary value, with
the raw `customer_id`/`account_id` underneath as a fallback — about 7-9% of
customers don't resolve (very recent accounts, or non-numeric IDs from
non-Hurrier source systems), in which case the raw ID is shown as the primary
value instead with a note. A small copy-icon next to each ID copies it to
your clipboard directly.

Each section has two CSV export buttons:
- **Download CSV (all)** — every row currently shown (after toggles/filters).
- **Download CSV (N selected)** — only the rows you've checked, for handing a
  reviewed shortlist to whoever files the block request.

Resolving analytical IDs adds a fixed ~10–30GB BigQuery scan per section per
refresh (the identifier table is 750M+ rows, clustered on validity dates, not
account ID, so the cost is roughly constant regardless of how few IDs you're
resolving). That's on top of each section's own query — an accepted,
deliberate cost for shipping IDs that are actually block-ready rather than
internal-only.

## Notes

- Sections 1 and 2 are Qatar-only, matching `location_change_delay_refund_pattern.sql`
  and `customer_repeat_refund_risk_score.sql` in the repo root — this dashboard
  doesn't add a country toggle on top of that. Section 3 is also filtered to
  `country_code = 'QA'`.
- All SQL inputs from the UI go through named BigQuery query parameters
  (`@days_back`, `@min_shift_meters`, `@ids`, ...), never string concatenation,
  so the toggles can't be turned into SQL injection.
- The two source `.sql` files in the repo root are the canonical, reviewable
  version of rules 1 and 2 — the queries embedded in `Code.gs` are the same
  logic, just parameterized. Rule 3 currently only exists inside `Code.gs`;
  ask if you want it split into its own `.sql` file too.
