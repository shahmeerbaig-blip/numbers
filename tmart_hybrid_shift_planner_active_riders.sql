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
-- (a) not tagged is_large_order, (b) at a store actually onboarded to the
-- Hybrid Fleet program (dedicated_vendor_list, from hybrid_fleet_store),
-- and (c) within that store's Hybrid dropoff-distance cap
-- (distance_cap, from hybrid_fleet_distance_cap_2 — same source/logic as
-- hybrid_fleet_qa_order_share_mom.sql's within_distance_scope). Counting
-- only orders Hybrid riders happened to deliver would make demand
-- self-limit to whatever headcount already existed, masking understaffing.
-- active_riders (supply) is still scoped to Hybrid riders only.
--
-- NOT VERIFIED LIVE: hybrid_fleet_store and hybrid_fleet_distance_cap_2
-- live in tlb-data-dev.data_platform_logistics, and the BigQuery
-- connection used to build this query got Access Denied on both tables
-- (metadata and query). The join logic below is ported as-is from
-- hybrid_fleet_qa_order_share_mom.sql's proven distance-cap handling, but
-- has NOT been run end-to-end against real data. Run it yourself (or a
-- LIMIT 20 sanity check per branch) before trusting the staffing numbers.
--
-- Also found: dim_logistics_vendor has duplicate rows per
-- (country_code, city_id, vendor_code) that differ only in location_id
-- (one populated, one NULL) — see vendor_city CTE, which collapses them
-- with GROUP BY + MAX(city_name) so the city lookup doesn't fan out order
-- rows. This is a pre-existing quirk in dim_logistics_vendor, not
-- something specific to this query.
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

-- Vendor -> city name lookup, deduped to one row per (country_code, city_id,
-- vendor_code) -- see the dim_logistics_vendor duplicate-row note above.
vendor_city AS (
  SELECT
    v.country_code,
    v.city_id,
    v.vendor_code,
    ANY_VALUE(v.vendor_name) AS vendor_name,
    MAX(dli.city_name) AS city
  FROM `tlb-data-prod.data_platform.dim_logistics_vendor` AS v
  LEFT JOIN `tlb-data-prod.data_platform.dim_location_info` AS dli
    ON v.location_id = dli.location_id
  WHERE v.country_code IN (@country_code, LOWER(@country_code), UPPER(@country_code))
  GROUP BY 1, 2, 3
),

-- Stores actually onboarded to the Hybrid Fleet program, and the window
-- during which each was part of it.
dedicated_vendor_list AS (
  SELECT
    country_code,
    CAST(vendor_id AS STRING) AS vendor_code,
    start_date,
    end_date
  FROM `tlb-data-dev.data_platform_logistics.hybrid_fleet_store`
  WHERE country_code IN (@country_code, LOWER(@country_code), UPPER(@country_code))
),

-- Max dropoff (DO) distance a Hybrid rider can be assigned, per city/vendor,
-- over time. Some countries cap by city+vendor, others by city only (when
-- vendor_name is NULL for that country's cap rows) -- same conditional key
-- as hybrid_fleet_qa_order_share_mom.sql.
distance_cap AS (
  SELECT
    country_code,
    CONCAT(city, '_', COALESCE(vendor_name, '')) AS city_vendor,
    value AS max_do_distance_km,
    start_date,
    end_date
  FROM `tlb-data-dev.data_platform_logistics.hybrid_fleet_distance_cap_2`
  WHERE distance_type = 'DO'
    AND country_code IN (@country_code, LOWER(@country_code), UPPER(@country_code))
),

hybrid_eligible_orders AS (
  SELECT
    o.order_code,
    o.created_date,
    oi.order_time,
    o.primary_dropoff_distance_manhattan,
    o.primary_stacked_count,
    o.order_status,
    vc.vendor_name AS branch_name
  FROM `tlb-data-prod.data_platform.fct_logistics_order` AS o
  INNER JOIN `tlb-data-prod.data_platform.fct_order_info` AS oi
    ON o.order_id = oi.order_id
    AND oi.order_date BETWEEN PARSE_DATE('%Y-%m-%d', @date_from) AND PARSE_DATE('%Y-%m-%d', @date_to)
  LEFT JOIN vendor_city AS vc
    ON o.country_code = vc.country_code
    AND o.city_id = vc.city_id
    AND o.vendor_code = vc.vendor_code
  INNER JOIN dedicated_vendor_list AS dvl
    ON o.country_code = dvl.country_code
    AND o.vendor_code = dvl.vendor_code
    AND o.created_date BETWEEN dvl.start_date AND dvl.end_date
  INNER JOIN distance_cap AS dc
    ON o.country_code = dc.country_code
    AND dc.city_vendor = (
      CASE
        WHEN o.country_code IN (
          SELECT DISTINCT country_code FROM distance_cap WHERE vendor_name IS NOT NULL
        )
        THEN CONCAT(vc.city, '_', COALESCE(vc.vendor_name, ''))
        ELSE CONCAT(vc.city, '_')
      END
    )
    AND o.created_date BETWEEN dc.start_date AND dc.end_date
  WHERE o.country_code IN (@country_code, LOWER(@country_code), UPPER(@country_code))
    AND o.is_rider_order = TRUE
    AND o.is_talabat = TRUE
    AND o.order_status IN ('completed', 'Completed', 'COMPLETED')
    AND oi.is_darkstore = TRUE
    AND o.created_date BETWEEN PARSE_DATE('%Y-%m-%d', @date_from) AND PARSE_DATE('%Y-%m-%d', @date_to)
    AND NOT COALESCE(o.is_large_order, FALSE)
    AND (o.primary_dropoff_distance_manhattan / 1000) <= dc.max_do_distance_km
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
