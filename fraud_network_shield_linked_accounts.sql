-- Fraud pattern: active (not-yet-blocked) Qatar accounts that Shield has
-- already linked, by shared device ID or mobile number, to at least one
-- confirmed-fraud account. This is the answer to "customer gets blocked,
-- makes a new account, keeps going" - ban evasion, not coincidence - sourced
-- directly from Shield's own network computation rather than a location
-- heuristic.
--
-- An earlier version of this pattern matched customers by shared dropoff
-- GPS coordinates instead of device/mobile linkage. Tested directly against
-- BigQuery over a trailing 180-day Qatar window, it produced 46,935 "shared
-- location" matches between a blocked and an active customer, almost all
-- from dense apartment buildings, not fraud - too noisy to ship.
-- `agg_customer_braze_fraud_flag`'s device/mobile-number network linkage is
-- Shield's own accurate version of the same idea.
--
-- Verified against `tlb-data-prod.data_platform.agg_customer_braze_fraud_flag`
-- (Aug 2026, QA): 58,004 active accounts are linked to >=1 Shield-confirmed
-- fraud account by device/mobile; 42,213 of those (73%) aren't themselves
-- yet flagged as fraud by Shield - still active and payable, one network hop
-- from a confirmed fraud account.
--
-- Scope: QA. No date range - unlike the other two rules, this is a
-- point-in-time snapshot of the current network state, not a trailing-window
-- event feed.

SELECT
  account_id,
  network_size,
  network_shield_fraud_account_count,
  network_shield_voucher_fraud_account_count,
  network_voucher_order_share,
  network_organic_order_share,
  is_shield_fraud,
  is_shield_voucher_fraud,
  is_device_rooted,
  is_app_cloned

FROM `tlb-data-prod.data_platform.agg_customer_braze_fraud_flag`
WHERE country_code = 'QA'
  AND NOT IFNULL(is_blocked, FALSE)                     -- active, not already blocked
  AND network_shield_fraud_account_count >= 1           -- linked to >=1 confirmed-fraud account
ORDER BY network_shield_fraud_account_count DESC, network_size DESC
