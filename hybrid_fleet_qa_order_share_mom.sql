-- Hybrid Fleet QA – Monthly Order Share % with MoM
-- Date range : 2025-10-01 → 2026-07-31
-- Scope filter: within_distance_scope = TRUE

WITH hybrid_fleet_vehicle AS (
  SELECT *
  FROM `tlb-data-dev.data_platform_logistics.hybrid_fleet_vehicle`
  WHERE country_code = 'qa'
),

distance_cap AS (
  SELECT
    *,
    CONCAT(city, '_', COALESCE(vendor_name, '')) AS city_vendor
  FROM `tlb-data-dev.data_platform_logistics.hybrid_fleet_distance_cap_2`
  WHERE country_code = 'qa'
),

vendor_info AS (
  SELECT
    CAST(dvi.vendor_id AS STRING)  AS vendor_id,
    dvi.vendor_name,
    LOWER(dvi.country_code)        AS country_code,
    dli.city_name                  AS city,
    CASE WHEN dvi.vendor_id = dvi.parent_vendor_id THEN TRUE ELSE FALSE END AS not_kiosk,
    dvi.is_darkstore
  FROM `tlb-data-prod.data_platform.dim_vendor_info`   AS dvi
  LEFT JOIN `tlb-data-prod.data_platform.dim_location_info` AS dli
    ON dvi.location_id = dli.location_id
  WHERE LOWER(dvi.country_code) = 'qa'
),

raw_data AS (
  SELECT DISTINCT
    o.order_id,
    o.platform_order_code                         AS order_code,
    o.country_code,
    o.entity.id                                   AS entity_id,
    o.vendor.vendor_code,
    d.dropoff_distance_manhattan / 1000           AS do_dist_km,
    d.delivery_distance / 1000                    AS delivery_distance,
    DATE(d.rider_dropped_off_at, d.timezone)      AS order_date,
    d.vehicle.vehicle_bag,
    d.vehicle.name                                AS vehicle_name,
    rv.vehicle_type,
    v.vendor_name,
    v.city,
    -- city_vendor key used to join distance caps
    CASE
      WHEN o.country_code IN (
        SELECT DISTINCT country_code
        FROM distance_cap
        WHERE distance_type = 'DO' AND vendor_name IS NOT NULL
      )
      THEN CONCAT(v.city, '_', COALESCE(v.vendor_name, ''))
      ELSE CONCAT(v.city, '_')
    END AS city_vendor,
    CASE WHEN h.vehicle_name IS NOT NULL THEN 'Hybrid Fleet'
         ELSE 'Shared Fleet' END AS fleet_type
  FROM `fulfillment-dwh-production.curated_data_shared.orders` o
  LEFT JOIN UNNEST(deliveries)      d
  LEFT JOIN UNNEST(d.transitions)   t
  INNER JOIN (SELECT * FROM vendor_info WHERE is_darkstore AND not_kiosk) v
    ON v.vendor_id = o.vendor.vendor_code AND v.country_code = o.country_code
  LEFT JOIN hybrid_fleet_vehicle h
    ON h.country_code = o.country_code AND d.vehicle.name = h.vehicle_name
  LEFT JOIN `tlb-data-prod.data_platform.dim_logistics_rider_vehicle` rv
    ON rv.country_code = o.country_code AND d.vehicle.vehicle_bag = rv.vehicle_bag
  WHERE created_date >= '2025-10-01'
    AND o.country_code = 'qa'
    AND o.entity.brand_id IN ('TB', 'TB_OT', 'HF')
    AND NOT o.is_preorder
    AND d.is_primary
    AND NOT d.is_returning
    AND NOT d.is_redelivery
    AND t.state = 'dispatched'
    AND (rv.vehicle_type = 'bike' OR h.vehicle_name IS NOT NULL)
  GROUP BY ALL
),

dedicated_vendor_list AS (
  SELECT
    h.country_code,
    CAST(v.vendor_id AS STRING) AS vendor_code,
    start_date,
    end_date,
    v.city
  FROM `tlb-data-dev.data_platform_logistics.hybrid_fleet_store` h
  LEFT JOIN vendor_info v
    ON v.vendor_id = CAST(h.vendor_id AS STRING) AND LOWER(v.country_code) = h.country_code
  WHERE h.country_code = 'qa'
),

-- Scoped orders: joined to dedicated vendor list + distance cap to compute within_distance_scope
scoped_orders AS (
  SELECT
    b.order_id,
    b.order_date,
    b.fleet_type,
    CASE
      WHEN b.fleet_type = 'Hybrid Fleet' AND dc.value >= b.do_dist_km       THEN TRUE
      WHEN b.fleet_type = 'Shared Fleet' AND dc.value >= b.delivery_distance THEN TRUE
      ELSE FALSE
    END AS within_distance_scope
  FROM raw_data b
  INNER JOIN dedicated_vendor_list dvl
    ON b.country_code = dvl.country_code AND b.vendor_code = dvl.vendor_code
  LEFT JOIN (SELECT * FROM distance_cap WHERE distance_type = 'DO') dc
    ON b.country_code = dc.country_code
    AND b.city_vendor  = dc.city_vendor
    AND b.order_date  >= dc.start_date
    AND b.order_date  <= dc.end_date
  WHERE b.order_date BETWEEN '2025-10-01' AND '2026-07-31'
    AND b.order_date < CURRENT_DATE()
),

-- Monthly order counts per fleet type (within-scope only)
monthly_fleet AS (
  SELECT
    DATE_TRUNC(order_date, MONTH) AS order_month,
    fleet_type,
    COUNT(DISTINCT order_id)       AS order_count
  FROM scoped_orders
  WHERE within_distance_scope = TRUE
  GROUP BY 1, 2
),

-- Total addressable orders per month (Hybrid + Shared combined)
monthly_total AS (
  SELECT
    order_month,
    SUM(order_count) AS total_orders
  FROM monthly_fleet
  GROUP BY 1
),

-- Order share % + prior-month values for MoM
order_share AS (
  SELECT
    f.order_month,
    f.fleet_type,
    f.order_count,
    t.total_orders,
    ROUND(f.order_count / t.total_orders * 100, 2)                          AS order_share_pct,

    LAG(f.order_count)
      OVER (PARTITION BY f.fleet_type ORDER BY f.order_month)               AS prev_order_count,
    LAG(ROUND(f.order_count / t.total_orders * 100, 2))
      OVER (PARTITION BY f.fleet_type ORDER BY f.order_month)               AS prev_order_share_pct
  FROM monthly_fleet f
  LEFT JOIN monthly_total t USING (order_month)
)

SELECT
  FORMAT_DATE('%b %Y', order_month)                                          AS month,
  fleet_type,

  -- Volume
  order_count,
  total_orders,

  -- Share this month
  ROUND(order_share_pct, 2)                                                  AS order_share_pct,

  -- Share last month
  ROUND(prev_order_share_pct, 2)                                             AS prev_month_order_share_pct,

  -- MoM share change in percentage points (pp)
  ROUND(order_share_pct - prev_order_share_pct, 2)                          AS mom_share_pp_change,

  -- MoM order count growth %
  ROUND(
    SAFE_DIVIDE(order_count - prev_order_count, prev_order_count) * 100, 1
  )                                                                           AS mom_order_count_pct_change

FROM order_share
ORDER BY order_month, fleet_type
