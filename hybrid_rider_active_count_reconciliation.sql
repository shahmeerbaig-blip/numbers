-- Hybrid Fleet QA – Active Rider Count Reconciliation
--
-- Context: the hourly/branch order breakdown query counts "active_riders" as
-- DISTINCT primary_rider_id with a completed, is_darkstore, is_rider_order
-- delivery in the period, filtered to riders whose dim_logistics_rider
-- last_contract_name LIKE '%HYBRID%'. That number regularly comes in lower
-- than the Hybrid roster headcount (e.g. "274 active hybrid riders"). This
-- query isolates the three reasons why, so the gap can be inspected instead
-- of guessed at:
--
-- 1) dim_logistics_rider is a CURRENT snapshot (refreshed daily) of each
--    rider's *latest* contract. Filtering on it tags a rider as Hybrid
--    based on their contract TODAY, not their contract on the order date.
--    A rider who was Hybrid during the queried period but has since moved
--    to another contract (or left) no longer matches last_contract_name
--    today and silently drops out. dim_logistics_rider_history
--    (valid_from/valid_to) fixes this by joining on the contract that was
--    valid on the order date itself.
-- 2) The roster headcount is a status count: it does not require the rider
--    to have actually delivered anything in the window. "active_riders"
--    requires a completed, darkstore, rider-order delivery, so any Hybrid
--    rider who was idle, on leave, newly onboarded, or only worked
--    non-darkstore orders in that window won't be counted as active.
-- 3) The original query GROUPs BY order_date, hour, branch_name, so its
--    active_riders column is a per-bucket distinct count, not a single
--    total for the period — summing or eyeballing individual rows will
--    always look smaller than a period-level headcount.

WITH roster_hybrid AS (
  SELECT rider_id
  FROM `tlb-data-prod.data_platform.dim_logistics_rider`
  WHERE country_code IN (@country_code, LOWER(@country_code), UPPER(@country_code))
    AND is_active = TRUE
    AND UPPER(last_contract_name) LIKE '%HYBRID%'
),

-- Same rider-tagging logic as the original hourly query (current snapshot,
-- not point-in-time), rolled up for the whole period instead of grouped by
-- hour/branch. This reproduces the original query's undercount for reason (1).
delivering_hybrid_current_snapshot AS (
  SELECT DISTINCT o.primary_rider_id AS rider_id
  FROM `tlb-data-prod.data_platform.fct_logistics_order` AS o
  INNER JOIN `tlb-data-prod.data_platform.fct_order_info` AS oi
    ON o.order_id = oi.order_id
    AND oi.order_date BETWEEN PARSE_DATE('%Y-%m-%d', @date_from) AND PARSE_DATE('%Y-%m-%d', @date_to)
  LEFT JOIN `tlb-data-prod.data_platform.dim_logistics_rider` AS r
    ON o.primary_rider_id = r.rider_id
  WHERE o.country_code IN (@country_code, LOWER(@country_code), UPPER(@country_code))
    AND o.is_rider_order = TRUE
    AND o.is_talabat = TRUE
    AND o.order_status IN ('completed', 'Completed', 'COMPLETED')
    AND oi.is_darkstore = TRUE
    AND o.created_date BETWEEN PARSE_DATE('%Y-%m-%d', @date_from) AND PARSE_DATE('%Y-%m-%d', @date_to)
    AND o.succesful_deliveries_count > 0
    AND UPPER(r.last_contract_name) LIKE '%HYBRID%'
),

-- Fixed version: tag the rider as Hybrid using the contract that was valid
-- ON THE ORDER DATE, not today's snapshot. Use this join in place of
-- dim_logistics_rider whenever "active_riders" needs to match a roster
-- headcount for a historical period.
delivering_hybrid_point_in_time AS (
  SELECT DISTINCT o.primary_rider_id AS rider_id
  FROM `tlb-data-prod.data_platform.fct_logistics_order` AS o
  INNER JOIN `tlb-data-prod.data_platform.fct_order_info` AS oi
    ON o.order_id = oi.order_id
    AND oi.order_date BETWEEN PARSE_DATE('%Y-%m-%d', @date_from) AND PARSE_DATE('%Y-%m-%d', @date_to)
  INNER JOIN `tlb-data-prod.data_platform.dim_logistics_rider_history` AS rh
    ON o.primary_rider_id = rh.rider_id
    AND o.created_date BETWEEN rh.valid_from AND rh.valid_to
  WHERE o.country_code IN (@country_code, LOWER(@country_code), UPPER(@country_code))
    AND o.is_rider_order = TRUE
    AND o.is_talabat = TRUE
    AND o.order_status IN ('completed', 'Completed', 'COMPLETED')
    AND oi.is_darkstore = TRUE
    AND o.created_date BETWEEN PARSE_DATE('%Y-%m-%d', @date_from) AND PARSE_DATE('%Y-%m-%d', @date_to)
    AND o.succesful_deliveries_count > 0
    AND UPPER(rh.last_contract_name) LIKE '%HYBRID%'
)

SELECT
  (SELECT COUNT(DISTINCT rider_id) FROM roster_hybrid)
    AS hybrid_roster_headcount,
  (SELECT COUNT(*) FROM delivering_hybrid_current_snapshot)
    AS active_riders_original_query_logic,
  (SELECT COUNT(*) FROM delivering_hybrid_point_in_time)
    AS active_riders_point_in_time_fixed,
  (SELECT COUNT(*) FROM roster_hybrid
    WHERE rider_id NOT IN (SELECT rider_id FROM delivering_hybrid_point_in_time))
    AS roster_riders_with_no_delivery_in_range
