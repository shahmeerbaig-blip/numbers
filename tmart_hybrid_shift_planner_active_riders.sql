-- TMart Hybrid Shift Planner — accurate active_riders per hour/branch
--
-- Replaces the shift planner's original active_riders metric (COUNT DISTINCT
-- rider with a completed delivery in that specific hour) with a count of
-- riders actually ON SHIFT that hour, using fct_logistics_rider_shift's
-- real clock-in/clock-out times. The order-completion proxy misses any
-- rider who is between deliveries, idle, or otherwise not dropping off in
-- that exact hour, which understates headcount and inflates UTR (orders
-- per rider) at the branch/hour level used for shift adjustments.
--
-- Also fixes hybrid-contract tagging to be point-in-time (via
-- dim_logistics_rider_history's valid_from/valid_to) instead of matching
-- against dim_logistics_rider's current-day snapshot, so a rider who was
-- Hybrid on the order date but has since changed contract still counts.
--
-- Demand vs. supply: orders_count/successful_orders are NOT restricted to
-- orders a Hybrid rider actually delivered. For staffing, what matters is
-- how many orders a Hybrid rider COULD have taken, i.e. orders that are
-- (a) not tagged is_large_order, and (b) within that branch's Hybrid
-- dropoff-distance cap (distance_cap_lookup below). Counting only orders
-- Hybrid riders happened to deliver would make demand self-limit to
-- whatever headcount already existed, masking understaffing. active_riders
-- (supply) is still scoped to Hybrid riders only, via the CTEs above.
--
-- distance_cap_lookup is a hardcoded VALUES table (QA branch caps as of
-- 2026-09-12, from ops config), NOT a join to
-- tlb-data-dev.data_platform_logistics.hybrid_fleet_distance_cap_2 --
-- that dataset is inaccessible to the account this dashboard's Apps Script
-- runs BigQuery as (Access Denied, confirmed live). If a branch isn't in
-- the lookup, it's treated as UNCAPPED (included without distance
-- filtering) rather than dropped, so a new/renamed branch doesn't silently
-- disappear from the dashboard -- check branch_name spelling if a known
-- branch's orders look uncapped when it shouldn't be.
--
-- Other notes:
-- 1) fct_logistics_rider_shift has no vendor_code (only sp_id/zone_id), so
--    a rider's branch for the day is inferred from wherever they had the
--    most completed orders that day (rider_primary_branch CTE).
-- 2) Shifts crossing midnight are clipped to hours on their start date
--    (see rider_shift_hours CTE).
-- 3) The final query is still driven FROM hybrid_eligible_orders, so an
--    hour with riders on shift but zero eligible orders won't appear as a
--    row.
-- 4) dim_logistics_vendor has duplicate rows per (country_code, city_id,
--    vendor_code) that differ only in location_id (one NULL, one
--    populated) -- harmless here since every aggregate below is either
--    COUNT(DISTINCT ...) or AVG (uniform 2x duplication doesn't change
--    either), but worth knowing before adding a SUM() or COUNT(*).

WITH order_days AS (
  SELECT
    o.created_date AS order_date,
    o.primary_rider_id AS rider_id,
    v.vendor_name AS branch_name,
    COUNT(DISTINCT o.order_code) AS orders_at_branch
  FROM `tlb-data-prod.data_platform.fct_logistics_order` AS o
  INNER JOIN `tlb-data-prod.data_platform.fct_order_info` AS oi
    ON o.order_id = oi.order_id
    AND oi.order_date BETWEEN PARSE_DATE('%Y-%m-%d', @date_from) AND PARSE_DATE('%Y-%m-%d', @date_to)
  LEFT JOIN `tlb-data-prod.data_platform.dim_logistics_vendor` AS v
    ON o.country_code = v.country_code
    AND o.city_id = v.city_id
    AND o.vendor_code = v.vendor_code
  INNER JOIN `tlb-data-prod.data_platform.dim_logistics_rider_history` AS rh
    ON o.primary_rider_id = rh.rider_id
    AND o.created_date BETWEEN rh.valid_from AND rh.valid_to
  WHERE o.country_code IN (@country_code, LOWER(@country_code), UPPER(@country_code))
    AND o.is_rider_order = TRUE
    AND o.is_talabat = TRUE
    AND o.order_status IN ('completed', 'Completed', 'COMPLETED')
    AND oi.is_darkstore = TRUE
    AND o.created_date BETWEEN PARSE_DATE('%Y-%m-%d', @date_from) AND PARSE_DATE('%Y-%m-%d', @date_to)
    AND UPPER(rh.last_contract_name) LIKE '%HYBRID%'
  GROUP BY 1, 2, 3
),

rider_primary_branch AS (
  SELECT order_date, rider_id, branch_name
  FROM (
    SELECT order_date, rider_id, branch_name,
      ROW_NUMBER() OVER (PARTITION BY order_date, rider_id ORDER BY orders_at_branch DESC) AS rn
    FROM order_days
  )
  WHERE rn = 1
),

-- Expand each rider's ACTUAL shift into the hours they were really clocked
-- in, so "active" means "on shift", not "happened to drop off in this hour".
rider_shift_hours AS (
  SELECT
    rpb.order_date,
    rpb.branch_name,
    s.rider_id,
    hr AS hour
  FROM rider_primary_branch AS rpb
  INNER JOIN `tlb-data-prod.data_platform.fct_logistics_rider_shift` AS s
    ON s.rider_id = rpb.rider_id
    AND s.created_date = rpb.order_date
    AND s.actual_start_at IS NOT NULL
    AND s.shift_state NOT IN ('cancelled', 'no show')
  CROSS JOIN UNNEST(GENERATE_ARRAY(
    EXTRACT(HOUR FROM COALESCE(s.actual_start_at, s.shift_start_at) AT TIME ZONE s.timezone),
    IF(DATE(COALESCE(s.actual_end_at, s.shift_end_at), s.timezone)
         != DATE(COALESCE(s.actual_start_at, s.shift_start_at), s.timezone),
       23,
       EXTRACT(HOUR FROM TIMESTAMP_SUB(COALESCE(s.actual_end_at, s.shift_end_at), INTERVAL 1 SECOND) AT TIME ZONE s.timezone)
    )
  )) AS hr
  -- Shifts crossing midnight are clipped to hours on their start date.
),

scheduled_riders AS (
  SELECT order_date, hour, branch_name, COUNT(DISTINCT rider_id) AS active_riders
  FROM rider_shift_hours
  GROUP BY 1, 2, 3
),

-- Hybrid Fleet dropoff-distance caps (km) per branch, per ops config
-- (hardcoded -- see header comment for why).
distance_cap_lookup AS (
  SELECT * FROM UNNEST([
    STRUCT('Talabat Mart , Old Al Rayyan' AS branch_name, 5.0 AS max_do_distance_km),
    STRUCT('talabat mart, Abu Hamour', 6.0),
    STRUCT('Talabat Mart, Al Khor', 11.0),
    STRUCT('talabat mart, Al manaseer', 3.5),
    STRUCT('talabat mart, Al Thumama', 5.0),
    STRUCT('talabat mart, Al Wakrah', 4.0),
    STRUCT('talabat mart, Bin Omran', 5.0),
    STRUCT('talabat mart, Lusail', 5.0),
    STRUCT('talabat mart,  Muntazh (new location)', 3.5),
    STRUCT('talabat mart, Umm Salal Ali', 5.0),
    STRUCT('talabat mart, Umm Salal Mohammed', 5.0)
  ])
),

hybrid_eligible_orders AS (
  SELECT
    o.order_code,
    o.created_date,
    oi.order_time,
    o.primary_dropoff_distance_manhattan,
    o.primary_stacked_count,
    o.order_status,
    v.vendor_name AS branch_name
  FROM `tlb-data-prod.data_platform.fct_logistics_order` AS o
  INNER JOIN `tlb-data-prod.data_platform.fct_order_info` AS oi
    ON o.order_id = oi.order_id
    AND oi.order_date BETWEEN PARSE_DATE('%Y-%m-%d', @date_from) AND PARSE_DATE('%Y-%m-%d', @date_to)
  LEFT JOIN `tlb-data-prod.data_platform.dim_logistics_vendor` AS v
    ON o.country_code = v.country_code
    AND o.city_id = v.city_id
    AND o.vendor_code = v.vendor_code
  LEFT JOIN distance_cap_lookup AS dc
    ON LOWER(TRIM(v.vendor_name)) = LOWER(TRIM(dc.branch_name))
  WHERE o.country_code IN (@country_code, LOWER(@country_code), UPPER(@country_code))
    AND o.is_rider_order = TRUE
    AND o.is_talabat = TRUE
    AND o.order_status IN ('completed', 'Completed', 'COMPLETED')
    AND oi.is_darkstore = TRUE
    AND o.created_date BETWEEN PARSE_DATE('%Y-%m-%d', @date_from) AND PARSE_DATE('%Y-%m-%d', @date_to)
    AND NOT COALESCE(o.is_large_order, FALSE)
    AND (dc.max_do_distance_km IS NULL OR (o.primary_dropoff_distance_manhattan / 1000) <= dc.max_do_distance_km)
)

SELECT
  heo.created_date as order_date,
  EXTRACT(HOUR FROM heo.order_time) as hour,
  heo.branch_name,
  COUNT(DISTINCT heo.order_code) as orders_count,
  COUNT(DISTINCT CASE WHEN heo.order_status IN ('completed', 'Completed', 'COMPLETED') THEN heo.order_code END) as successful_orders,
  AVG(heo.primary_dropoff_distance_manhattan / 1000) as avg_distance_km,
  SAFE_DIVIDE(
    COUNT(DISTINCT CASE WHEN heo.primary_stacked_count > 0 THEN heo.order_code END),
    COUNT(DISTINCT heo.order_code)
  ) as stacking_rate,
  ANY_VALUE(sr.active_riders) as active_riders
FROM hybrid_eligible_orders AS heo
LEFT JOIN scheduled_riders sr
  ON sr.order_date = heo.created_date
  AND sr.hour = EXTRACT(HOUR FROM heo.order_time)
  AND sr.branch_name = heo.branch_name
GROUP BY order_date, hour, branch_name
ORDER BY branch_name, hour
