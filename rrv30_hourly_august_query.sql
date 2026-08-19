-- Query to get hourly RRV30 for each Talabat Marts from Aug 1-17, 2026
WITH tmart_stores AS
(
  SELECT
    dvi.vendor_id,
    dvi.vendor_name,
    dvi.country_code
  FROM `tlb-data-prod.data_platform.dim_vendor_info` AS dvi
  WHERE dvi.country_code = 'QA'
    AND dvi.is_darkstore
    AND dvi.parent_vendor_id = dvi.vendor_id
),

benchmarks AS
(
  SELECT 'qa' AS country_code, 16 AS value_prop, 3.00 AS prep_time_benchmark, 2.5 AS store_dispatch_time_benchmark, 3.0 AS rrv_30m_benchmark, 3.0 AS avt_30m_benchmark, 10.22 AS tct_benchmark
),

base AS
(
  SELECT
    UPPER(o.country_code)                       AS country_code,
    DATE(o.created_at, o.timezone)              AS order_date,
    EXTRACT(HOUR FROM TIMESTAMP(o.created_at, o.timezone)) AS order_hour,
    o.vendor.vendor_code,
    v.vendor_name,
    o.platform_order_code,
    o.timings.actual_delivery_time/60           AS adt_mins,
    o.timings.to_customer_time/60               AS tct_mins,
    COALESCE(d.is_stacked_intravendor, FALSE)   AS is_stacked,
    COALESCE("large_order" IN UNNEST(tags), FALSE) AS is_large_order,
    (TIMESTAMP_DIFF(d.rider_accepted_at, o.created_at, SECOND)
      + IF(TIMESTAMP_DIFF(d.rider_30m_to_pickup_at, d.rider_accepted_at, SECOND) < 0, 0,
           TIMESTAMP_DIFF(d.rider_30m_to_pickup_at, d.rider_accepted_at, SECOND)))/60 AS rrv_30m_mins,
    TIMESTAMP_DIFF(d.rider_picked_up_at, d.rider_30m_to_pickup_at, SECOND)/60         AS avt_30m_mins,
    pb.value_prop,
    pb.prep_time_benchmark,
    pb.store_dispatch_time_benchmark,
    pb.rrv_30m_benchmark,
    pb.avt_30m_benchmark,
    pb.tct_benchmark
  FROM `fulfillment-dwh-production.curated_data_shared.orders` o
    LEFT JOIN UNNEST(deliveries) d
    INNER JOIN tmart_stores v
      ON CAST(v.vendor_id AS STRING) = o.vendor.vendor_code
      AND LOWER(v.country_code) = o.country_code
    LEFT JOIN benchmarks pb ON o.country_code = pb.country_code
  WHERE created_date BETWEEN '2026-08-01' AND '2026-08-17'
    AND entity.brand_id IN ("TB","TB_OT","HF")
    AND o.country_code = 'qa'
    AND d.is_primary
    AND d.is_returning IS FALSE
    AND COALESCE(d.is_redelivery, FALSE) IS FALSE
    AND o.order_status = 'completed'
    AND d.delivery_status = 'completed'
    AND vendor.vertical_type = 'darkstores'
),

picking_data AS
(
  SELECT
    country_code,
    order_id,
    (assignment_time_seconds + picking_time_seconds + packaging_time_seconds)/60 AS total_prep_time,
    store_dispatch_time_seconds/60 AS store_dispatch_time
  FROM `tlb-data-prod.data_platform.fct_picker_order`
  WHERE created_date BETWEEN '2026-08-01' AND '2026-08-17'
    AND global_entity_id = 'TB_QA'
    AND is_dmart_picker
),

combined_rd AS
(
  SELECT
    b.country_code,
    b.order_date,
    b.order_hour,
    b.vendor_name,
    b.platform_order_code,
    b.is_stacked,
    b.adt_mins,
    b.rrv_30m_mins,
    b.avt_30m_mins,
    b.tct_mins,
    p.total_prep_time,
    p.store_dispatch_time,
    b.value_prop,
    b.prep_time_benchmark,
    b.store_dispatch_time_benchmark,
    b.rrv_30m_benchmark,
    b.avt_30m_benchmark,
    b.tct_benchmark
  FROM base b
    LEFT JOIN picking_data p
      ON b.country_code = p.country_code
      AND b.platform_order_code = CAST(p.order_id AS STRING)
  WHERE NOT b.is_large_order
),

hourly_metrics AS
(
  SELECT
    country_code,
    order_date,
    order_hour,
    vendor_name,
    rrv_30m_benchmark,
    avt_30m_benchmark,
    prep_time_benchmark,
    store_dispatch_time_benchmark,
    tct_benchmark,
    value_prop,
    COUNT(DISTINCT platform_order_code) AS total_orders,
    ROUND(AVG(rrv_30m_mins), 2) AS avg_rrv_30m_mins,
    ROUND(AVG(avt_30m_mins), 2) AS avg_avt_30m_mins,
    ROUND(AVG(total_prep_time), 2) AS avg_prep_time,
    ROUND(AVG(store_dispatch_time), 2) AS avg_store_dispatch_time,
    ROUND(AVG(tct_mins), 2) AS avg_tct_mins,
    ROUND(AVG(adt_mins), 2) AS avg_adt_mins,
    ROUND(COUNT(DISTINCT CASE WHEN rrv_30m_mins <= rrv_30m_benchmark THEN platform_order_code END) /
          NULLIF(COUNT(DISTINCT platform_order_code), 0), 4) AS rrv_30m_compliance,
    ROUND(COUNT(DISTINCT CASE WHEN is_stacked THEN platform_order_code END) /
          NULLIF(COUNT(DISTINCT platform_order_code), 0), 4) AS stacking_perc
  FROM combined_rd
  GROUP BY ALL
)

SELECT
  country_code,
  order_date,
  order_hour,
  vendor_name,
  total_orders,
  avg_rrv_30m_mins,
  rrv_30m_benchmark,
  rrv_30m_compliance,
  avg_avt_30m_mins,
  avg_prep_time,
  avg_store_dispatch_time,
  avg_tct_mins,
  avg_adt_mins,
  stacking_perc
FROM hourly_metrics
ORDER BY order_date, order_hour, vendor_name
