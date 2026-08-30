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
3. **Fraud network** (`fraud_network_shield_linked_accounts.sql`) —
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
them pull the full customer or order base. Each table is also paginated at
20 rows/page (Prev/Next below the table) so a large result set doesn't stall
the page rendering hundreds of rows at once — sort, "select all", and CSV
export still operate on the full filtered set, not just the visible page.

## Customer Lookup tab

A second tab (next to "Fraud Patterns") for investigating one customer
directly: search by analytical customer ID or raw numeric customer ID, pick
a window (30/90/180/365 days, or **All time**, plus a custom day count), and
it shows:

- **Identity** — the analytical ID, the raw account ID(s) it resolves to
  (an analytical ID can be linked to more than one raw account if Talabat's
  identity stitching has merged them — capped at the 10 most recently active,
  since a handful of analytical IDs are degenerate catch-alls linked to
  1000+ accounts and aren't a real "same person" signal).
- **Pattern badges** — which of the three patterns above this customer has
  actually triggered in the selected window, computed live rather than
  requiring you to cross-reference the other three tables by hand.
- **Order history** — one row per order with the distinct set of contact
  reasons, event types, outcomes, and refunded/compensated EUR value across
  every claim event on that order. Sortable, paginated, CSV-exportable.

Two cost notes specific to this tab:
- "All time" for the order-history and claim-total queries (against
  `comp_and_refund_events`) is genuinely unbounded. For the location-change
  check specifically (against the much larger `orders` table),
  "All time" is capped at 2 years — an unbounded scan of that table for even
  one customer blows past BigQuery's bytes-billed safety limit, tested
  directly.
- Each search runs up to 5 sequential BigQuery queries (ID resolution, order
  history, location-change check, claims aggregate, fraud-network lookup),
  so expect it to take longer than the toggle-driven refreshes on the other
  tab — it's a deliberate one-customer investigation action, not something
  that runs on every keystroke.

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
- Most SQL inputs from the UI go through named BigQuery query parameters
  (`@days_back`, `@min_shift_meters`, `@min_claims`, ...). The one exception is
  customer/account ID lists (used for analytical-ID resolution and the
  Customer Lookup tab), which are built as literal `IN (...)` lists instead
  of a bound `ARRAY` parameter — a real bug was found where BigQuery's
  Advanced Service silently matched zero rows on a bound array parameter
  instead of erroring. Every ID in those lists is validated as a clean
  integer (`isFinite` + `Math.trunc` + string round-trip check) before being
  inlined, so there's no injection surface despite not being a bound
  parameter.
- The three source `.sql` files in the repo root are the canonical, reviewable
  version of rules 1–3 — the queries embedded in `Code.gs` are the same
  logic, just parameterized.
