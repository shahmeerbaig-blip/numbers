/**
 * Qatar Refund Fraud Signals — Apps Script backend.
 *
 * Runs three rules live against BigQuery, on demand, with the thresholds
 * below exposed as dashboard toggles. Every query already filters down to
 * flagged/violating rows only — none of them pull the full customer or
 * order base.
 *
 *   1. Location change -> delay -> refund   (location_change_delay_refund_pattern.sql)
 *   2. Repeat-offender risk score           (customer_repeat_refund_risk_score.sql)
 *   3. Fraud network (new)                  active accounts already linked, by
 *      device/mobile number, to a Shield-confirmed fraud account but not yet
 *      blocked. This replaces an earlier idea of matching customers by shared
 *      dropoff GPS coordinates: that was tested directly against BigQuery and
 *      found too noisy in a dense city (46,935 "shared address" matches over
 *      180 days in Qatar alone, almost all from apartment buildings, not
 *      fraud). Shield's own device/mobile-number network linkage
 *      (agg_customer_braze_fraud_flag.network_shield_fraud_account_count) is
 *      the accurate version of "this is the same person on a new account."
 *
 * Every row is also enriched with the customer's analytical_customer_id
 * (Talabat's standard cross-system customer key, resolved via
 * rltnp_account_x_identifiers) so results are ready to hand to a block
 * request without a manual lookup step.
 *
 * SETUP (one-time, see README.md in this folder for the full walkthrough):
 *   1. Resources > Advanced Google services > enable "BigQuery API" (or add
 *      it via appsscript.json — see the manifest checked in alongside this file).
 *   2. The Google account that opens the deployed web app needs:
 *      - BigQuery jobUser (or equivalent) on BILLING_PROJECT below
 *      - Read access to fulfillment-dwh-production.curated_data_shared and
 *        tlb-data-prod.data_platform
 *   3. Deploy > New deployment > Web app. Execute as "User accessing the web
 *      app" so BigQuery runs under each viewer's own credentials/quota.
 */

var BILLING_PROJECT = 'tlb-data-dev';

var LATE_OR_ADDRESS_REASONS = [
  'Delayed delivery',
  'Request: order is late, does not want to wait',
  'Complaint about moderate delay',
  'Complaint about short delay',
  'Complaint about extreme delay',
  'Complaint about severe delay',
  'Complain about late order',
  'Wrong address/pinpoint',
  'ETA is stuck or increasing'
];

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Qatar Refund Fraud Signals')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Clamp a user-supplied toggle value to a safe numeric range before it ever reaches SQL. */
function clamp_(value, fallback, min, max) {
  var n = Number(value);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function intParam_(name, value) {
  return { name: name, parameterType: { type: 'INT64' }, parameterValue: { value: String(value) } };
}

/**
 * Runs a parameterized query against BigQuery under BILLING_PROJECT and
 * returns rows as plain objects keyed by column name. Named parameters
 * (@foo) are the only way user input reaches the query — never string
 * concatenation — so toggles can't be turned into SQL injection.
 */
function runQuery_(sql, params) {
  var request = {
    query: sql,
    useLegacySql: false,
    parameterMode: 'NAMED',
    queryParameters: params || [],
    timeoutMs: 30000
  };

  var result = BigQuery.Jobs.query(request, BILLING_PROJECT);
  var jobId = result.jobReference.jobId;
  var location = result.jobReference.location;

  while (!result.jobComplete) {
    Utilities.sleep(1000);
    result = BigQuery.Jobs.getQueryResults(BILLING_PROJECT, jobId, { location: location });
  }

  var rows = result.rows || [];
  var pageToken = result.pageToken;
  while (pageToken) {
    var next = BigQuery.Jobs.getQueryResults(BILLING_PROJECT, jobId, { location: location, pageToken: pageToken });
    rows = rows.concat(next.rows || []);
    pageToken = next.pageToken;
  }

  if (!result.schema) return [];
  var fields = result.schema.fields;
  return rows.map(function (row) {
    var obj = {};
    row.f.forEach(function (cell, i) {
      obj[fields[i].name] = cell.v;
    });
    return obj;
  });
}

/**
 * Resolves Talabat's standard analytical_customer_id for a list of raw
 * numeric customer/account IDs, via the current (latest valid_from) row per
 * account_id in rltnp_account_x_identifiers. IDs that aren't numeric (~0.8%
 * of comp_and_refund_events rows, from non-Hurrier source systems) or that
 * don't resolve (~7-9%, mostly very new accounts) are simply omitted from
 * the returned map — callers fall back to the raw ID for those.
 *
 * Note: this table is 750M+ rows clustered on valid_to/valid_from, not
 * account_id, so this lookup scans ~25-30GB regardless of how few IDs are
 * requested. That's an accepted, deliberate cost for shipping a block-ready
 * ID rather than an internal-only one — see README.md.
 */
function resolveAnalyticalIds_(rawIds) {
  var numericIds = [];
  rawIds.forEach(function (id) {
    var n = Number(id);
    if (id != null && isFinite(n) && String(Math.trunc(n)) === String(id).trim()) numericIds.push(Math.trunc(n));
  });
  numericIds = Array.from(new Set(numericIds));
  if (!numericIds.length) return {};

  // Built as a literal IN (...) list rather than a bound ARRAY<INT64> query
  // parameter. Every element of idList is guaranteed a clean JS integer by
  // the isFinite/Math.trunc/round-trip check above, so .join(',') can only
  // ever produce digits, minus signs, and commas - there is no string data
  // here that could carry an injection payload. This sidesteps a BigQuery
  // Advanced Service quirk where ARRAY-typed query parameters were silently
  // matching zero rows instead of erroring, which is worth knowing about if
  // you build another parameterized array elsewhere in this file.
  var idList = numericIds.join(',');
  var sql = [
    'WITH ranked AS (',
    '  SELECT account_id, analytical_customer_id,',
    '    ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY valid_from DESC) AS rn',
    '  FROM `tlb-data-prod.data_platform.rltnp_account_x_identifiers`',
    '  WHERE account_id IN (' + idList + ')',
    ')',
    'SELECT account_id, analytical_customer_id FROM ranked WHERE rn = 1'
  ].join('\n');

  var map = {};
  runQuery_(sql, []).forEach(function (r) {
    if (r.analytical_customer_id) map[String(r.account_id)] = r.analytical_customer_id;
  });
  Logger.log('resolveAnalyticalIds_: requested %s ids, resolved %s', numericIds.length, Object.keys(map).length);
  return map;
}

/** Attaches analytical_customer_id (or null) to every row, keyed off `idField`. */
function attachAnalyticalIds_(rows, idField) {
  var ids = rows.map(function (r) { return r[idField]; });
  var map = resolveAnalyticalIds_(ids);
  rows.forEach(function (r) {
    r.analytical_customer_id = map[String(r[idField])] || null;
  });
  return rows;
}

/**
 * Pattern 1: dropoff pin shifted mid-order, delivery was delayed, customer
 * then filed a late-delivery/wrong-address refund or comp claim on that order.
 * Toggles: date range (days back), min pin shift (meters), min delay (seconds).
 */
function getLocationChangeData(opts) {
  opts = opts || {};
  var daysBack = clamp_(opts.daysBack, 90, 1, 365);
  var minShiftMeters = clamp_(opts.minShiftMeters, 500, 0, 50000);
  var minDelaySeconds = clamp_(opts.minDelaySeconds, 300, 0, 36000);

  var sql = [
    'WITH location_shift_orders AS (',
    '  SELECT',
    '    o.global_order_id AS order_id,',
    '    o.created_date AS order_date,',
    '    d.timings.delivery_delay AS delivery_delay_seconds,',
    '    ST_DISTANCE(d.expected_dropoff, d.dropoff) AS dropoff_shift_meters',
    '  FROM `fulfillment-dwh-production.curated_data_shared.orders` o',
    '  LEFT JOIN UNNEST(o.deliveries) d',
    '  WHERE o.created_date >= DATE_SUB(CURRENT_DATE(), INTERVAL @days_back DAY)',
    '    AND o.country_code = \'qa\'',
    '    AND d.is_primary',
    '    AND NOT d.is_returning',
    '    AND NOT d.is_redelivery',
    '    AND d.expected_dropoff IS NOT NULL',
    '    AND d.dropoff IS NOT NULL',
    '    AND ST_DISTANCE(d.expected_dropoff, d.dropoff) > @min_shift_meters',
    '    AND d.timings.delivery_delay > @min_delay_seconds',
    '),',
    'late_or_address_claims AS (',
    '  SELECT',
    '    order_id, customer_id, vendor_id, created_date AS claim_date,',
    '    event_type, contact_reason_l3, purpose, request_type, outcome, csat_score,',
    '    COALESCE(compensation_value_eur, 0) + COALESCE(refund_value_eur, 0) AS claim_value_eur',
    '  FROM `fulfillment-dwh-production.curated_data_shared.comp_and_refund_events`',
    '  WHERE created_date >= DATE_SUB(CURRENT_DATE(), INTERVAL @days_back DAY)',
    '    AND country = \'Qatar\'',
    '    AND contact_reason_l3 IN UNNEST(@late_reasons)',
    '),',
    'flagged_claims AS (',
    '  SELECT',
    '    c.customer_id, l.order_id, l.order_date, l.dropoff_shift_meters, l.delivery_delay_seconds,',
    '    c.vendor_id, c.claim_date, c.event_type, c.contact_reason_l3, c.purpose, c.request_type,',
    '    c.outcome, c.csat_score, c.claim_value_eur',
    '  FROM location_shift_orders l',
    '  INNER JOIN late_or_address_claims c USING (order_id)',
    ')',
    'SELECT',
    '  customer_id, order_id, order_date,',
    '  ROUND(dropoff_shift_meters, 0) AS dropoff_shift_meters,',
    '  delivery_delay_seconds, vendor_id, claim_date, event_type, contact_reason_l3, purpose,',
    '  request_type, outcome, csat_score,',
    '  ROUND(claim_value_eur, 2) AS claim_value_eur,',
    '  COUNT(*) OVER (PARTITION BY customer_id) AS customer_pattern_claim_count,',
    '  ROUND(SUM(claim_value_eur) OVER (PARTITION BY customer_id), 2) AS customer_pattern_total_value_eur',
    'FROM flagged_claims',
    'ORDER BY customer_pattern_claim_count DESC, claim_value_eur DESC'
  ].join('\n');

  var params = [
    intParam_('days_back', daysBack),
    intParam_('min_shift_meters', minShiftMeters),
    intParam_('min_delay_seconds', minDelaySeconds),
    {
      name: 'late_reasons',
      parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
      parameterValue: { arrayValues: LATE_OR_ADDRESS_REASONS.map(function (r) { return { value: r }; }) }
    }
  ];

  var rows = attachAnalyticalIds_(runQuery_(sql, params), 'customer_id');

  return {
    rows: rows,
    appliedFilters: { daysBack: daysBack, minShiftMeters: minShiftMeters, minDelaySeconds: minDelaySeconds }
  };
}

/**
 * Pattern 2: repeat-offender risk score — 0-100 blend of trailing claim
 * frequency + EUR value, tiered LOW/MEDIUM/HIGH. Toggles: date range, min claims.
 *
 * The score itself still counts every comp_and_refund_events reason equally
 * (cancellations and item-level claims alike) - confirmed via a real case
 * that this can be dominated by partner/vendor-initiated cancellations,
 * which aren't a customer fraud signal the same way a self-reported
 * missing/wrong item claim is. Rather than silently drop cancellations from
 * the score, every row also reports cancellation_claim_count/value alongside
 * item_claim_count/value so a reviewer can see the split before acting on a
 * high score driven mostly by cancellations.
 */
function getRiskScoreData(opts) {
  opts = opts || {};
  var daysBack = clamp_(opts.daysBack, 90, 1, 365);
  var minClaims = clamp_(opts.minClaims, 3, 1, 1000);

  var sql = [
    'WITH claims_window AS (',
    '  SELECT',
    '    customer_id,',
    '    COUNT(*) AS claim_count,',
    '    COUNT(DISTINCT order_id) AS distinct_orders_claimed,',
    '    COUNT(DISTINCT vendor_id) AS distinct_vendors_claimed,',
    '    SUM(COALESCE(compensation_value_eur, 0) + COALESCE(refund_value_eur, 0)) AS total_claim_value_eur,',
    '    COUNTIF(request_type = \'Manual\') AS manual_claim_count,',
    '    COUNTIF(contact_reason_l2 = \'Cancellation\') AS cancellation_claim_count,',
    '    SUM(IF(contact_reason_l2 = \'Cancellation\', COALESCE(compensation_value_eur, 0) + COALESCE(refund_value_eur, 0), 0)) AS cancellation_claim_value_eur,',
    '    ROUND(AVG(csat_score), 2) AS avg_csat_score,',
    '    MIN(created_date) AS first_claim_date,',
    '    MAX(created_date) AS last_claim_date',
    '  FROM `fulfillment-dwh-production.curated_data_shared.comp_and_refund_events`',
    '  WHERE created_date >= DATE_SUB(CURRENT_DATE(), INTERVAL @days_back DAY)',
    '    AND country = \'Qatar\'',
    '    AND customer_id IS NOT NULL',
    '  GROUP BY customer_id',
    '),',
    'scored AS (',
    '  SELECT *,',
    '    PERCENT_RANK() OVER (ORDER BY claim_count) AS claim_count_pctile,',
    '    PERCENT_RANK() OVER (ORDER BY total_claim_value_eur) AS claim_value_pctile',
    '  FROM claims_window',
    ')',
    'SELECT',
    '  customer_id, claim_count, distinct_orders_claimed, distinct_vendors_claimed,',
    '  ROUND(total_claim_value_eur, 2) AS total_claim_value_eur, manual_claim_count, avg_csat_score,',
    '  cancellation_claim_count,',
    '  claim_count - cancellation_claim_count AS item_claim_count,',
    '  ROUND(cancellation_claim_value_eur, 2) AS cancellation_claim_value_eur,',
    '  ROUND(total_claim_value_eur - cancellation_claim_value_eur, 2) AS item_claim_value_eur,',
    '  first_claim_date, last_claim_date,',
    '  ROUND(50 * claim_count_pctile + 50 * claim_value_pctile, 1) AS risk_score_0_100,',
    '  CASE',
    '    WHEN 50 * claim_count_pctile + 50 * claim_value_pctile >= 90 THEN \'HIGH\'',
    '    WHEN 50 * claim_count_pctile + 50 * claim_value_pctile >= 70 THEN \'MEDIUM\'',
    '    ELSE \'LOW\'',
    '  END AS risk_tier',
    'FROM scored',
    'WHERE claim_count >= @min_claims',
    'ORDER BY risk_score_0_100 DESC'
  ].join('\n');

  var params = [
    intParam_('days_back', daysBack),
    intParam_('min_claims', minClaims)
  ];

  var rows = attachAnalyticalIds_(runQuery_(sql, params), 'customer_id');

  return {
    rows: rows,
    appliedFilters: { daysBack: daysBack, minClaims: minClaims }
  };
}

/**
 * Pattern 3 (new): active (not yet blocked) Qatar accounts that Shield has
 * already linked, by shared device or mobile number, to at least one
 * confirmed-fraud account. These are the highest-confidence "same person,
 * new account" candidates — ban-evasion, not coincidence — sourced directly
 * from Shield's own network computation rather than a location heuristic.
 * Toggle: min linked fraud accounts.
 */
function getFraudNetworkData(opts) {
  opts = opts || {};
  var minLinkedFraud = clamp_(opts.minLinkedFraud, 1, 1, 500);

  var sql = [
    'SELECT',
    '  account_id, network_size, network_shield_fraud_account_count,',
    '  network_shield_voucher_fraud_account_count, network_voucher_order_share,',
    '  network_organic_order_share, is_shield_fraud, is_shield_voucher_fraud,',
    '  is_device_rooted, is_app_cloned',
    'FROM `tlb-data-prod.data_platform.agg_customer_braze_fraud_flag`',
    'WHERE country_code = \'QA\'',
    '  AND NOT IFNULL(is_blocked, FALSE)',
    '  AND network_shield_fraud_account_count >= @min_linked_fraud',
    'ORDER BY network_shield_fraud_account_count DESC, network_size DESC'
  ].join('\n');

  var params = [intParam_('min_linked_fraud', minLinkedFraud)];

  var rows = attachAnalyticalIds_(runQuery_(sql, params), 'account_id');

  return {
    rows: rows,
    appliedFilters: { minLinkedFraud: minLinkedFraud }
  };
}
