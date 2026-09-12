# TMart Hybrid Shift Planner — Project Summary

For use as Claude Project knowledge. Covers what the dashboard does, what
changed and why, and what's still open.

## What this is

A Google Apps Script web app (`Code.gs` + `index.html`) for Qatar TMart
darkstore branches. It pulls hourly order demand and Hybrid Fleet rider
supply from BigQuery, then lets ops plan shift windows and rider counts
per branch and see projected UTR (orders per rider) and coverage.

Repo: `shahmeerbaig-blip/numbers`, branch `claude/hybrid-rider-count-query-qkxa3k`,
folder `tmart-hybrid-shift-planner/`.

## The two numbers that matter

- **`orders_count`** — demand: every darkstore order a Hybrid rider *could*
  have taken (completed, `is_rider_order`, `is_talabat`, `is_darkstore`),
  excluding `is_large_order` (Hybrid can't carry those) and orders beyond
  the branch's Hybrid dropoff-distance cap. Not filtered by who actually
  delivered it.
- **`active_riders`** — supply: Hybrid-contract riders actually on shift
  that hour, from `fct_logistics_rider_shift` (real clock-in/out).

UTR = demand / supply. Both sides had to be fixed independently to make
that ratio mean anything (see below).

## What changed, in order, and why

1. **Point-in-time hybrid tagging.** `dim_logistics_rider` is a
   *current-day snapshot* — filtering it tags a rider as Hybrid based on
   their contract *today*, not on the historical order date. Switched to
   `dim_logistics_rider_history` (`valid_from`/`valid_to`) so a rider who
   was Hybrid back then but has since changed contract still counts for
   that historical day. This is also the fix for "274 active hybrid riders
   vs 198 in the query" from earlier in this conversation.

2. **`active_riders` from real shifts, not delivery timestamps.** The
   original query counted a rider as active in an hour only if they
   completed a delivery in that exact hour — missing anyone idle, between
   drop-offs, or just not dropping off right then. Replaced with
   `fct_logistics_rider_shift`, expanding each rider's actual
   `actual_start_at`→`actual_end_at` (falling back to planned times) into
   the hours they covered. Rider→branch attribution uses whichever branch
   they had the most completed orders at that day (the shift table has no
   vendor_code, only `sp_id`/`zone_id`).

3. **Demand redefined as "hybrid-eligible", not "hybrid-delivered".**
   Originally `orders_count` only counted orders a Hybrid rider actually
   delivered — that makes demand self-limit to whatever headcount already
   existed (if only 8 riders were on shift, demand could never look like
   more than ~8 riders' worth of orders), hiding understaffing. Redefined
   to count all eligible orders regardless of who delivered them, minus
   `is_large_order`.

4. **Hybrid distance-cap discovery.** Hybrid riders also can't be assigned
   orders beyond a per-branch dropoff-distance cap (confirmed by the user
   with a screenshot of real per-branch caps). The proper source for this,
   `tlb-data-dev.data_platform_logistics.hybrid_fleet_distance_cap_2` (and
   `hybrid_fleet_store` for which stores are Hybrid-dedicated), is
   **Access Denied** to the BigQuery credentials this project runs under
   — confirmed both from the analysis tool used to build this and live
   from the Apps Script itself.

5. **Hardcoded distance-cap lookup instead.** Since the dev dataset is
   unreachable, `distance_cap_lookup` in the BigQuery query is a literal
   `UNNEST([STRUCT(...), ...])` table built from the user-provided branch
   caps (see below), joined on `LOWER(TRIM(vendor_name))`. A branch not in
   the list is treated as **uncapped**, not dropped, so an unlisted/new
   branch doesn't silently vanish from the dashboard. Verified live against
   QA/2026-08-30 — e.g. Al Wakrah's remaining orders after the 4km cap
   average ~2–2.7km dropoff, as expected.

6. **Dashboard-side distance filter fixes** (`index.html`):
   - `DEFAULT_DIST_CAP` now seeds the same 11 branch caps by default
     (case/whitespace-normalized name matching), instead of the sidebar
     inputs starting blank.
   - "Reset to defaults" used to wipe every branch to *no cap* — now
     restores the real caps instead.
   - The `Dist filter` header badge was dead markup (CSS `.on` state
     existed, JS never touched it) — now reflects how many visible
     branches currently have an active cap.
   - The dashboard's own distance filter (`distFraction()`) is a
     *client-side approximation*: it scales an hour's order count by
     `cap / avgDistanceThatHour`, because the frontend only ever receives
     the average dropoff distance per hour/branch, not individual order
     distances. It is not as precise as the BigQuery-side per-order
     exclusion in `orders_count`, and the two aren't the same number by
     design — the query result already has the cap baked in; the frontend
     slider is a for tuning "what if the cap were different" without a
     round-trip to BigQuery.

## Current branch distance caps (km), hardcoded in both `Code.gs` and `index.html`

| Branch | Cap (km) |
|---|---|
| Talabat Mart , Old Al Rayyan | 5.0 |
| talabat mart, Abu Hamour | 6.0 |
| Talabat Mart, Al Khor | 11.0 |
| talabat mart, Al manaseer | 3.5 |
| talabat mart, Al Thumama | 5.0 |
| talabat mart, Al Wakrah | 4.0 |
| talabat mart, Bin Omran | 5.0 |
| talabat mart, Lusail | 5.0 |
| talabat mart,  Muntazh (new location) | 3.5 |
| talabat mart, Umm Salal Ali | 5.0 |
| talabat mart, Umm Salal Mohammed | 5.0 |

Branch name casing/spacing above is exact — it must match `vendor_name` in
`dim_logistics_vendor` verbatim (case-insensitively, after whitespace
normalization) or that branch's cap silently won't apply.

## Known limitations / open items

- **Blocked on BigQuery access**: `tlb-data-dev.data_platform_logistics`
  (`hybrid_fleet_store`, `hybrid_fleet_distance_cap_2`) is Access Denied.
  If access is granted later, replace the hardcoded `distance_cap_lookup`
  (in `Code.gs`) and `DEFAULT_DIST_CAP` (in `index.html`) with a live
  join/fetch so caps update automatically instead of needing manual edits
  in two places whenever they change. The distance-cap-joined query
  version (before the hardcoded fallback) is preserved in git history at
  commit `7685501` for reference.
- A branch not in the hardcoded cap list is uncapped by design (see #5
  above) — worth double-checking new branches get added promptly.
- `dim_logistics_vendor` has duplicate rows per
  `(country_code, city_id, vendor_code)` differing only in `location_id`
  (one NULL, one populated). Harmless today because every aggregate in the
  query is `COUNT(DISTINCT ...)` or `AVG` (uniform 2x duplication doesn't
  change either), but would corrupt a `SUM()` or `COUNT(*)` if one gets
  added later.
- The query is driven `FROM hybrid_eligible_orders`, so an hour with
  riders on shift but zero eligible orders won't appear as a row at all —
  "overstaffed, no demand" hours aren't currently surfaced.
- Shifts crossing midnight are clipped to hours on their start calendar
  date only; the overflow into the next day isn't attributed anywhere.

## Deploy

See `README.md` in this same folder for exact steps (there's no Apps
Script API connector available to provision the project automatically —
it's a ~2-minute manual copy-paste into script.google.com).
