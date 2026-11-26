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
6. Deploy → New deployment → type "Web app". Execute as **Me (the deploying
   account)** — every viewer's BigQuery (and Live Order Tracker Sheets) calls
   run under the deploying account's own credentials/quota, not each
   viewer's — and set access to whoever should see this.
7. Open the deployed URL. First run will prompt for OAuth consent
   (BigQuery read-only scope).

Only the deploying account needs read access to
`fulfillment-dwh-production.curated_data_shared`, `tlb-data-prod.data_platform`
(for the fraud/identity tables), job-create on `tlb-data-dev`, and read access
to the Live Order Tracker Sheet — viewers of the dashboard itself don't need
any of these grants.

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

## Order Lookup tab

A third tab for investigating a single order: search by numeric order ID and
it shows every compensation/refund case raised on that order (each with the
Talabat order-fail reason — `fct_order_info.order_fail_reason_id` →
`dim_order_fail_reason.talabat_reason` — shown as a sub-category under the
contact/compensation reason), plus the same three fraud rules as the Fraud
Patterns tab evaluated for this specific order and its customer:

- **Location change** is checked on this order only (its own pin shift +
  delay + whether it has a late/wrong-address claim).
- **Repeat claimer** and **fraud network** are customer-level, same as
  Customer Lookup — the repeat-claimer window has its own pill selector
  (30/90/180/365 days), independent of the Fraud Patterns date range.

Searches the last 365 days (`ORDER_SEARCH_DAYS` in `Code.gs`) — both for
claim history (`comp_and_refund_events` isn't clustered by `order_id`, so an
unbounded scan trips BigQuery's bytes-billed cap) and, for numeric order IDs,
`fct_order_info`. Orders older than that aren't found by this tab.

## Live Order Tracker tab

A fourth tab for looking up an order that's still in flight — placed seconds
or minutes ago, before it's reached any BigQuery batch table this dashboard
can query directly. Search by numeric order ID and it shows the order's
current status (vendor, value, payment method, latest status) plus the
customer behind it, with the same repeat-offender and fraud-network checks
as Order Lookup — those work even for a brand-new order, since they only
depend on the customer's own history, not this specific order.

This tab reads a Google Sheet (`LIVE_ORDERS_SHEET_ID` /
`LIVE_ORDERS_SHEET_TAB` in `Code.gs`) rather than querying BigQuery itself:
`fulfillment-dwh-production.curated_data_shared_data_stream.order_stream` is
a true real-time order-placement event stream, but this dashboard has no
BigQuery access to it. Instead, whoever does have access owns a Sheet fed
from it via a Connected Sheet to BigQuery, filtered to whatever scope they
chose (currently: Qatar orders over 500 QAR placed in the last 12 hours —
anything outside that range is a miss in this tab specifically, not "no
fraud signal," so fall back to Order Lookup for those).

Setup specific to this tab:
- Needs the `https://www.googleapis.com/auth/spreadsheets.readonly` scope
  in `appsscript.json` (already included). Since this deployment executes
  as the deploying account rather than each viewer (see Setup step 6), only
  the deploying account needs read access to that Sheet — a plain Sheets
  share, no BigQuery permission involved, and nothing viewers need.
- `LIVE_REFRESH_URL` / `LIVE_REFRESH_KEY` in `Code.gs` call a tiny separate
  Web App (see `live_order_feeder/Code.gs`) that the Sheet's owner deploys
  themselves, which re-runs the Sheet's Connected Sheet refresh under their
  own BigQuery credentials right before this tab reads it — so refreshing
  never needs this dashboard's deploying account to have BigQuery access to
  the stream either. `LIVE_REFRESH_KEY` is meant as a shared secret gating
  that endpoint — keep it a real rotated value if the endpoint should
  actually be gated; a known/default value leaves it open to anyone with
  the URL.
- The Sheet's columns are looked up by header name, not position, so
  reordering columns on the Sheet owner's side doesn't break this tab —
  but renaming a column, or renaming the tab itself, does.

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
