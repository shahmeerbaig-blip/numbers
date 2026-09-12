// ============================================================================
// TMART HYBRID SHIFT PLANNER - GOOGLE APPS SCRIPT
// ============================================================================

const PROJECT_ID = 'tlb-nondatateam-analysis-9264';

const BIGQUERY_QUERY = `
WITH order_days AS (
  SELECT
    o.created_date AS order_date,
    o.primary_rider_id AS rider_id,
    v.vendor_name AS branch_name,
    COUNT(DISTINCT o.order_code) AS orders_at_branch
  FROM \`tlb-data-prod.data_platform.fct_logistics_order\` AS o
  INNER JOIN \`tlb-data-prod.data_platform.fct_order_info\` AS oi
    ON o.order_id = oi.order_id
    AND oi.order_date BETWEEN PARSE_DATE('%Y-%m-%d', @date_from) AND PARSE_DATE('%Y-%m-%d', @date_to)
  LEFT JOIN \`tlb-data-prod.data_platform.dim_logistics_vendor\` AS v
    ON o.country_code = v.country_code
    AND o.city_id = v.city_id
    AND o.vendor_code = v.vendor_code
  INNER JOIN \`tlb-data-prod.data_platform.dim_logistics_rider_history\` AS rh
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
  INNER JOIN \`tlb-data-prod.data_platform.fct_logistics_rider_shift\` AS s
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

-- Hybrid Fleet dropoff-distance caps (km) per branch, per ops config
-- (hardcoded -- tlb-data-dev.data_platform_logistics.hybrid_fleet_distance_cap_2
-- is inaccessible to this project's BigQuery credentials).
distance_cap_lookup AS (
  SELECT * FROM UNNEST([
    STRUCT('Talabat Mart , Old Al Rayyan' AS branch_name, 5.0 AS max_do_distance_km),
    STRUCT('talabat mart, Abu Hamour', 6.0),
    STRUCT('Talabat Mart, Al Khor', 11.0),
    STRUCT('talabat mart, Al manaseer', 3.5),
    STRUCT('talabat mart, Al Thumama', 5.0),
    STRUCT('talabat mart, Al Wakrah', 4.0),
    STRUCT('talabat mart, Bin Omran', 5.0),
    STRUCT('talabat mart, Lusail', 5.0),
    STRUCT('talabat mart,  Muntazh (new location)', 3.5),
    STRUCT('talabat mart, Umm Salal Ali', 5.0),
    STRUCT('talabat mart, Umm Salal Mohammed', 5.0)
  ])
),

hybrid_eligible_orders AS (
  SELECT
    o.order_code,
    o.created_date,
    oi.order_time,
    o.primary_dropoff_distance_manhattan,
    o.primary_stacked_count,
    o.order_status,
    v.vendor_name AS branch_name
  FROM \`tlb-data-prod.data_platform.fct_logistics_order\` AS o
  INNER JOIN \`tlb-data-prod.data_platform.fct_order_info\` AS oi
    ON o.order_id = oi.order_id
    AND oi.order_date BETWEEN PARSE_DATE('%Y-%m-%d', @date_from) AND PARSE_DATE('%Y-%m-%d', @date_to)
  LEFT JOIN \`tlb-data-prod.data_platform.dim_logistics_vendor\` AS v
    ON o.country_code = v.country_code
    AND o.city_id = v.city_id
    AND o.vendor_code = v.vendor_code
  LEFT JOIN distance_cap_lookup AS dc
    ON LOWER(TRIM(v.vendor_name)) = LOWER(TRIM(dc.branch_name))
  WHERE o.country_code IN (@country_code, LOWER(@country_code), UPPER(@country_code))
    AND o.is_rider_order = TRUE
    AND o.is_talabat = TRUE
    AND o.order_status IN ('completed', 'Completed', 'COMPLETED')
    AND oi.is_darkstore = TRUE
    AND o.created_date BETWEEN PARSE_DATE('%Y-%m-%d', @date_from) AND PARSE_DATE('%Y-%m-%d', @date_to)
    AND NOT COALESCE(o.is_large_order, FALSE)
    AND (dc.max_do_distance_km IS NULL OR (o.primary_dropoff_distance_manhattan / 1000) <= dc.max_do_distance_km)
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
`;

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setWidth(1600)
    .setHeight(900)
    .setSandboxMode(HtmlService.SandboxMode.IFRAME);
}

// ============================================================================
// DATA PIPELINE
// ============================================================================

function getInitialData(params) {
  let fromStr, toStr, country;

  if (!params || !params.from || !params.to) {
    // Default to Yesterday (T-1)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    toStr = Utilities.formatDate(yesterday, 'UTC', 'yyyy-MM-dd');
    fromStr = Utilities.formatDate(yesterday, 'UTC', 'yyyy-MM-dd');
    country = 'QA';
  } else {
    fromStr = params.from;
    toStr = params.to;
    country = params.country || 'QA';
  }

  // Smart Caching: If end date is in the past, cache for 24 hours.
  const todayStr = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  const isHistorical = (toStr < todayStr);
  const cacheDuration = isHistorical ? 86400 : 3600;

  const cacheKey = 'br_v3_' + country + '_' + fromStr + '_' + toStr;
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);

  let branches;
  if (cached) {
    branches = JSON.parse(cached);
  } else {
    const bqResult = autoUpdateFromBigQuery(fromStr, toStr, country);

    if (bqResult && bqResult.error) {
      return { error: bqResult.error, queryDate: `${fromStr} to ${toStr} (${country})` };
    }

    branches = bqResult || [];
    if (branches.length > 0) {
      cache.put(cacheKey, JSON.stringify(branches), cacheDuration);
    }
  }

  return { branches: branches, queryDate: `${fromStr} to ${toStr} (${country})` };
}

function autoUpdateFromBigQuery(dateFrom, dateTo, country) {
  try {
    const request = {
      query: BIGQUERY_QUERY,
      useLegacySql: false,
      queryParameters: [
        { name: 'date_from', parameterType: { type: 'STRING' }, parameterValue: { value: dateFrom } },
        { name: 'date_to', parameterType: { type: 'STRING' }, parameterValue: { value: dateTo } },
        { name: 'country_code', parameterType: { type: 'STRING' }, parameterValue: { value: country } }
      ],
      maxResults: 10000
    };

    const queryResults = BigQuery.Jobs.query(request, PROJECT_ID);

    if (queryResults.errorResult) {
      return { error: queryResults.errorResult.message };
    }

    if (!queryResults.rows || queryResults.rows.length === 0) return [];

    return transformBigQueryToBranches(queryResults.rows, dateFrom, dateTo);
  } catch (error) {
    return { error: error.toString() };
  }
}

function transformBigQueryToBranches(rows, dateFrom, dateTo) {
  const tFrom = new Date(dateFrom);
  const tTo = new Date(dateTo);
  const totalDays = Math.max(1, Math.round((tTo - tFrom) / (1000 * 60 * 60 * 24)) + 1);
  const branchMap = {};

  rows.forEach(row => {
    const f = row.f;
    const hour = parseInt(f[1].v);
    const branchName = f[2].v;
    const successfulOrders = parseFloat(f[4].v) || 0;
    const avgDistance = parseFloat(f[5].v) || 0;
    const stackingRate = parseFloat(f[6].v) || 0;
    const activeRiders = parseFloat(f[7].v) || 0;

    if (!branchMap[branchName]) {
      branchMap[branchName] = {
        name: branchName,
        ordersSum: Array(24).fill(0),
        distSum: Array(24).fill(0),
        distCnt: Array(24).fill(0),
        stkSum: Array(24).fill(0),
        ridersSum: Array(24).fill(0)
      };
    }

    const b = branchMap[branchName];
    b.ordersSum[hour] += successfulOrders;

    if (avgDistance > 0) {
      b.distSum[hour] += avgDistance;
      b.distCnt[hour] += 1;
    }

    b.stkSum[hour] += stackingRate;
    b.ridersSum[hour] += activeRiders;
  });

  return Object.values(branchMap).map(b => {
    const branch = {
      name: b.name,
      riders: 0,
      orders: Array(24).fill(0),
      utr: Array(24).fill(0),
      dist: Array(24).fill(0),
      stk: Array(24).fill(0),
      pct: Array(24).fill(0)
    };

    let maxHourlyRiders = 0;

    for (let h = 0; h < 24; h++) {
      branch.orders[h] = b.ordersSum[h] / totalDays;
      branch.dist[h] = b.distCnt[h] > 0 ? (b.distSum[h] / b.distCnt[h]) : 3.5;
      branch.stk[h] = b.stkSum[h] / totalDays;

      const avgRidersHr = b.ridersSum[h] / totalDays;
      if (avgRidersHr > maxHourlyRiders) maxHourlyRiders = avgRidersHr;

      if (avgRidersHr > 0) {
        branch.utr[h] = parseFloat((branch.orders[h] / avgRidersHr).toFixed(2));
      } else {
        branch.utr[h] = null;
      }
    }

    branch.riders = Math.max(1, Math.round(maxHourlyRiders));
    const totalOrders = branch.orders.reduce((a, c) => a + c, 0) || 1;
    branch.pct = branch.orders.map(o => (o / totalOrders) * 100);

    return branch;
  });
}
