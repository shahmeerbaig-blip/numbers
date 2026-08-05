-- Rider rating & order metrics aggregated by month (QA)
-- Date range: 2025-07-01 → 2026-07-31

SELECT
  o.country_code,
  DATE_TRUNC(
    DATE(COALESCE(primary_rider_dropped_off_at, hurrier_order_placed_at), o.timezone),
    MONTH
  )                                                                             AS order_month,

  -- Volume
  COUNT(DISTINCT CASE WHEN o.order_status = 'completed' THEN o.order_id END)  AS no_of_orders,
  COUNT(DISTINCT r.order_id)                                                    AS no_of_ratings,

  -- Average rider rating (all reasons)
  ROUND(AVG(r.driver_rating), 2)                                               AS avg_rider_rating,

  -- Average rating excluding late-delivery reason
  ROUND(
    SAFE_DIVIDE(
      SUM(CASE WHEN r.driver_rating_reason IS NULL
                 OR r.driver_rating_reason NOT LIKE '%Delivery time%'
               THEN r.driver_rating END),
      COUNT(DISTINCT CASE WHEN r.driver_rating_reason IS NULL
                            OR r.driver_rating_reason NOT LIKE '%Delivery time%'
                          THEN r.order_id END)
    ), 2
  )                                                                             AS avg_rating_excl_late,

  -- Negative rating breakdowns
  COUNT(DISTINCT CASE WHEN r.driver_rating_reason LIKE '%Rider hygiene%'
                        AND r.driver_rating <= 2 THEN r.order_id END)          AS appearance_low_rating,
  COUNT(DISTINCT CASE WHEN (r.driver_rating_reason LIKE '%Rider behavior%'
                         OR r.driver_rating_reason LIKE '%Unfriendly%')
                        AND r.driver_rating <= 2 THEN r.order_id END)          AS behavior_low_rating,
  COUNT(DISTINCT CASE WHEN r.driver_rating_reason LIKE '%contactless%'
                         OR r.driver_rating_reason LIKE '%instruction ignored%'
                       THEN r.order_id END)                                    AS contactless_low_rating,

  -- Order damage
  COUNT(DISTINCT CASE WHEN reason = 'FOOD_QUALITY_SPILLAGE'
                       THEN oi.order_id END)                                   AS order_damage_count,

  -- Vendor reviews
  COUNT(vendor_rider_review_emotion)                                            AS no_of_vendor_reviews,
  SUM(CASE WHEN vendor_rider_review_emotion = 'positive' THEN 1 ELSE 0 END)   AS no_of_positive_reviews,
  SUM(CASE WHEN vendor_rider_review_emotion = 'negative' THEN 1 ELSE 0 END)   AS no_of_negative_reviews

FROM `tlb-data-prod.data_platform.fct_logistics_order` o
LEFT JOIN `tlb-data-prod.data_platform.fct_rating`            r  ON r.order_id  = o.order_id
LEFT JOIN `tlb-data-prod.data_platform.fct_order_info`        oi ON oi.order_id = o.order_id
LEFT JOIN `tlb-data-prod.data_platform.dim_order_fail_reason`    USING (order_fail_reason_id)
LEFT JOIN `tlb-data-prod.data_platform.dim_logistics_city`    c  ON o.country_code = c.country_code
                                                                 AND o.city_id      = c.city_id
WHERE DATE(COALESCE(primary_rider_dropped_off_at, hurrier_order_placed_at), o.timezone)
        BETWEEN '2025-07-01' AND '2026-07-31'
  AND o.country_code = 'qa'

GROUP BY 1, 2
ORDER BY order_month
