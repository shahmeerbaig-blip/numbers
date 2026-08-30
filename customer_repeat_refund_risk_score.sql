-- Repeat-offender risk score: ranks customers by frequency + EUR value of
-- refund/compensation claims over a trailing 90-day window, across ALL claim
-- reasons (not just the location-change pattern — see
-- location_change_delay_refund_pattern.sql for that specific rule).
-- Scope: Qatar only.
--
-- Source: comp_and_refund_events (event-level Autocomp/OneView/Help Center
-- feed). `country` is the full name ("Qatar"), not an ISO code. `with_item_removal`
-- was checked and is 'N/A' for 100% of rows in the last 90 days, so it's
-- excluded — not a usable signal today.
--
-- Score is a simple, transparent 0-100 blend of where a customer sits versus
-- everyone else on (a) how often they claim and (b) how much EUR they've
-- claimed. Deliberately not a black-box weighting — this is meant to be a
-- reviewable SQL rule, not a model.

WITH claims_90d AS (
  SELECT
    customer_id,
    COUNT(*)                                                                 AS claim_count,
    COUNT(DISTINCT order_id)                                                 AS distinct_orders_claimed,
    COUNT(DISTINCT vendor_id)                                                AS distinct_vendors_claimed,
    SUM(COALESCE(compensation_value_eur, 0) + COALESCE(refund_value_eur, 0)) AS total_claim_value_eur,
    COUNTIF(request_type = 'Manual')                                        AS manual_claim_count,
    ROUND(AVG(csat_score), 2)                                               AS avg_csat_score,
    MIN(created_date)                                                       AS first_claim_date,
    MAX(created_date)                                                       AS last_claim_date
  FROM `fulfillment-dwh-production.curated_data_shared.comp_and_refund_events`
  WHERE created_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
    AND country = 'Qatar'
    AND customer_id IS NOT NULL
  GROUP BY customer_id
),

scored AS (
  SELECT
    *,
    PERCENT_RANK() OVER (ORDER BY claim_count)         AS claim_count_pctile,
    PERCENT_RANK() OVER (ORDER BY total_claim_value_eur) AS claim_value_pctile
  FROM claims_90d
)

SELECT
  customer_id,
  claim_count,
  distinct_orders_claimed,
  distinct_vendors_claimed,
  ROUND(total_claim_value_eur, 2)                                           AS total_claim_value_eur,
  manual_claim_count,
  avg_csat_score,
  first_claim_date,
  last_claim_date,
  ROUND(50 * claim_count_pctile + 50 * claim_value_pctile, 1)               AS risk_score_0_100,
  CASE
    WHEN 50 * claim_count_pctile + 50 * claim_value_pctile >= 90 THEN 'HIGH'
    WHEN 50 * claim_count_pctile + 50 * claim_value_pctile >= 70 THEN 'MEDIUM'
    ELSE 'LOW'
  END                                                                        AS risk_tier

FROM scored
WHERE claim_count >= 3   -- repeat offenders only; excludes one-off legitimate claims
ORDER BY risk_score_0_100 DESC
