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
-- Notes:
-- 1) fct_logistics_rider_shift has no vendor_code (only sp_id/zone_id), so
--    a rider's branch for the day is inferred from wherever they had the
--    most completed orders that day (rider_primary_branch CTE).
-- 2) Shifts crossing midnight are clipped to hours on their start date
--    (see rider_shift_hours CTE).
-- 3) The final query is still driven FROM fct_logistics_order, so an
--    hour with riders on shift but zero orders won't appear as a row.
--
-- Demand vs. supply: orders_count/successful_orders in the final SELECT are
-- NOT restricted to orders a Hybrid rider actually delivered. For staffing,
-- what matters is how many orders a Hybrid rider COULD have taken -- i.e.
-- every darkstore order except ones tagged is_large_order (Hybrid riders
-- can't carry large orders). Counting only orders Hybrid riders happened to
-- deliver would make demand self-limit to whatever headcount already
-- existed that hour, masking understaffing. active_riders (supply) is still
-- scoped to Hybrid riders only, via the CTEs above.
--
-- Reverted (commit after 7685501): that version also gated demand by
-- dedicated_vendor_list (hybrid_fleet_store) and a Hybrid dropoff-distance
-- cap (hybrid_fleet_distance_cap_2), matching hybrid_fleet_qa_order_share_mom.sql.
-- Both tables live in tlb-data-dev.data_platform_logistics, and the
-- account this dashboard's Apps Script runs BigQuery as got Access Denied
-- on them. Once that account has read access to that dataset, restore the
-- distance-cap version from git history (commit 7685501) instead of this
-- large-order-only fallback.

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
)

SELECT
  o.created_date as order_date,
  EXTRACT(HOUR FROM oi.order_time) as hour,
  v.vendor_name as branch_name,
  COUNT(DISTINCT o.order_code) as orders_count,
  COUNT(DISTINCT CASE WHEN o.order_status IN ('completed', 'Completed', 'COMPLETED') THEN o.order_code END) as successful_orders,
  AVG(o.primary_dropoff_distance_manhattan / 1000) as avg_distance_km,
  SAFE_DIVIDE(
    COUNT(DISTINCT CASE WHEN o.primary_stacked_count > 0 THEN o.order_code END),
    COUNT(DISTINCT o.order_code)
  ) as stacking_rate,
  ANY_VALUE(sr.active_riders) as active_riders
FROM `tlb-data-prod.data_platform.fct_logistics_order` as o
INNER JOIN `tlb-data-prod.data_platform.fct_order_info` as oi
  ON o.order_id = oi.order_id
  AND oi.order_date BETWEEN PARSE_DATE('%Y-%m-%d', @date_from) AND PARSE_DATE('%Y-%m-%d', @date_to)
LEFT JOIN `tlb-data-prod.data_platform.dim_logistics_vendor` as v
  ON o.country_code = v.country_code
  AND o.city_id = v.city_id
  AND o.vendor_code = v.vendor_code
LEFT JOIN scheduled_riders sr
  ON sr.order_date = o.created_date
  AND sr.hour = EXTRACT(HOUR FROM oi.order_time)
  AND sr.branch_name = v.vendor_name
WHERE o.country_code IN (@country_code, LOWER(@country_code), UPPER(@country_code))
  AND o.is_rider_order = TRUE
  AND o.is_talabat = TRUE
  AND o.order_status IN ('completed', 'Completed', 'COMPLETED')
  AND oi.is_darkstore = TRUE
  AND o.created_date BETWEEN PARSE_DATE('%Y-%m-%d', @date_from) AND PARSE_DATE('%Y-%m-%d', @date_to)
  AND NOT COALESCE(o.is_large_order, FALSE)
GROUP BY order_date, hour, branch_name
ORDER BY branch_name, hour
