-- Fraud pattern: customer shifts delivery pin mid-order (after dispatch), the
-- shift correlates with a delivery delay, then a late-delivery / wrong-address
-- refund or compensation claim is filed on the same order.
-- Scope: QA. Date range: trailing 90 days from CURRENT_DATE().
--
-- Location-change signal: ST_DISTANCE(expected_dropoff, dropoff) on the primary
-- delivery. Verified against `fulfillment-dwh-production.curated_data_shared.orders`
-- (Aug 2026, QA): 90% of orders land within ~47m of the dispatch-time expected
-- dropoff (GPS/rider precision noise); >500m only happens on ~1.1% of orders,
-- so it's a clean proxy for an actual mid-order location change.
--
-- Claim-reason list and join key (comp_and_refund_events.order_id matches
-- orders.global_order_id / platform_order_code, NOT the internal orders.order_id)
-- were confirmed directly against the data, not assumed.

WITH location_shift_orders AS (
  SELECT
    o.global_order_id                                    AS order_id,
    o.created_date                                       AS order_date,
    d.timings.delivery_delay                             AS delivery_delay_seconds,
    ST_DISTANCE(d.expected_dropoff, d.dropoff)            AS dropoff_shift_meters
  FROM `fulfillment-dwh-production.curated_data_shared.orders` o
  LEFT JOIN UNNEST(o.deliveries) d
  WHERE o.created_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
    AND o.country_code = 'qa'
    AND d.is_primary
    AND NOT d.is_returning
    AND NOT d.is_redelivery
    AND d.expected_dropoff IS NOT NULL
    AND d.dropoff IS NOT NULL
    AND ST_DISTANCE(d.expected_dropoff, d.dropoff) > 500       -- meaningful pin shift
    AND d.timings.delivery_delay > 300                         -- shift coincided with >5min delay
),

late_or_address_claims AS (
  SELECT
    order_id,
    customer_id,
    vendor_id,
    created_date                                          AS claim_date,
    event_type,
    contact_reason_l3,
    purpose,
    request_type,
    outcome,
    csat_score,
    COALESCE(compensation_value_eur, 0) + COALESCE(refund_value_eur, 0) AS claim_value_eur
  FROM `fulfillment-dwh-production.curated_data_shared.comp_and_refund_events`
  WHERE created_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
    AND country = 'Qatar'
    AND contact_reason_l3 IN (
      'Delayed delivery',
      'Request: order is late, does not want to wait',
      'Complaint about moderate delay',
      'Complaint about short delay',
      'Complaint about extreme delay',
      'Complaint about severe delay',
      'Complain about late order',
      'Wrong address/pinpoint',
      'ETA is stuck or increasing'
    )
),

flagged_claims AS (
  SELECT
    c.customer_id,
    l.order_id,
    l.order_date,
    l.dropoff_shift_meters,
    l.delivery_delay_seconds,
    c.vendor_id,
    c.claim_date,
    c.event_type,
    c.contact_reason_l3,
    c.purpose,
    c.request_type,
    c.outcome,
    c.csat_score,
    c.claim_value_eur
  FROM location_shift_orders l
  INNER JOIN late_or_address_claims c USING (order_id)
)

SELECT
  customer_id,
  order_id,
  order_date,
  ROUND(dropoff_shift_meters, 0)                                            AS dropoff_shift_meters,
  delivery_delay_seconds,
  vendor_id,
  claim_date,
  event_type,
  contact_reason_l3,
  purpose,
  request_type,
  outcome,
  csat_score,
  ROUND(claim_value_eur, 2)                                                 AS claim_value_eur,

  -- repeat-use signal: how often this customer has run this exact pattern
  COUNT(*)      OVER (PARTITION BY customer_id)                             AS customer_pattern_claim_count,
  ROUND(SUM(claim_value_eur) OVER (PARTITION BY customer_id), 2)            AS customer_pattern_total_value_eur

FROM flagged_claims
ORDER BY customer_pattern_claim_count DESC, claim_value_eur DESC
