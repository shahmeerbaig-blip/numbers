// ============================================================================
// TALABAT MART SHIFT PLANNING DASHBOARD - GOOGLE APPS SCRIPT
// ============================================================================

// BigQuery Configuration
const PROJECT_ID = 'tlb-data-prod';
const BIGQUERY_QUERY = `
SELECT
  DATE(fct_logistics_order.created_date) as order_date,
  EXTRACT(HOUR FROM fct_logistics_order.created_date) as hour,
  dim_logistics_vendor.vendor_name as branch_name,
  COUNT(DISTINCT fct_logistics_order.order_code) as orders_count,
  COUNT(DISTINCT CASE WHEN fct_logistics_order.order_status = 'completed' THEN fct_logistics_order.order_code END) as successful_orders,
  AVG(fct_logistics_order.primary_dropoff_distance_manhattan / 1000) as avg_distance_km,
  SAFE_DIVIDE(
    COUNT(DISTINCT CASE WHEN fct_logistics_order.primary_stacked_count > 0 THEN fct_logistics_order.order_code END),
    COUNT(DISTINCT fct_logistics_order.order_code)
  ) as stacking_rate,
  COUNT(DISTINCT CASE WHEN fct_logistics_order.succesful_deliveries_count > 0 THEN fct_logistics_order.primary_rider_id ELSE NULL END) as active_riders
FROM \`tlb-data-prod.data_platform.fct_logistics_order\` as fct_logistics_order
LEFT JOIN \`tlb-data-prod.data_platform.dim_logistics_vendor\` as dim_logistics_vendor
  ON fct_logistics_order.country_code = dim_logistics_vendor.country_code
  AND fct_logistics_order.city_id = dim_logistics_vendor.city_id
  AND fct_logistics_order.vendor_code = dim_logistics_vendor.vendor_code
LEFT JOIN \`tlb-data-prod.data_platform.dim_logistics_rider\` as dim_logistics_rider
  ON fct_logistics_order.primary_rider_id = dim_logistics_rider.rider_id
WHERE UPPER(fct_logistics_order.country_code) = 'QA'
  AND fct_logistics_order.is_rider_order = TRUE
  AND fct_logistics_order.is_talabat = TRUE
  AND fct_logistics_order.order_status = 'completed'
  AND DATE(fct_logistics_order.created_date) = @query_date
  AND UPPER(dim_logistics_rider.last_contract_name) LIKE '%HYBRID%'
GROUP BY order_date, hour, branch_name
ORDER BY branch_name, hour
`;

// ============================================================================
// SERVE THE HTML UI
// ============================================================================
function doGet() {
  return HtmlService.createHtmlOutput(getHTML())
    .setWidth(1600)
    .setHeight(900)
    .setSandboxMode(HtmlService.SandboxMode.IFRAME);
}

function getHTML() {
  return HtmlService.createTemplateFromFile('HTML').evaluate().getContent();
}

// ============================================================================
// CORE CALCULATIONS
// ============================================================================

function scaledPct(pct, orderPct) {
  return pct.map(v => +(v * orderPct / 100).toFixed(4));
}

function stackedDemand(val, stkOn, stkRate) {
  if (!stkOn) return val;
  return +(val * (1 - stkRate / 200)).toFixed(4);
}

function stackedUTR(baseUTR, stkOn, stkRate) {
  if (!stkOn) return baseUTR;
  return +(baseUTR * (1 - stkRate / 200)).toFixed(2);
}

function inShift(hour, shiftStart, shiftEnd) {
  if (shiftEnd > 24) {
    return hour >= shiftStart || hour < (shiftEnd - 24);
  }
  return hour >= shiftStart && hour < shiftEnd;
}

function splitRiders(branch, nShifts, shifts, manualRiders) {
  if (manualRiders) {
    return {
      r1: manualRiders.r1 || 0,
      r2: manualRiders.r2 || 0,
      r3: manualRiders.r3 || 0
    };
  }

  if (nShifts === 1) {
    return { r1: branch.riders, r2: 0, r3: 0 };
  }

  const weights = [];
  for (let k = 0; k < nShifts; k++) {
    const s = shifts[k].start;
    const e = shifts[k].end;
    let w = 0;
    for (let i = s; i < Math.min(e, 24); i++) {
      w += branch.pct[i] || 0;
    }
    weights.push(w);
  }

  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  let riders = weights.map(w => Math.max(1, Math.round(branch.riders * w / totalWeight)));
  let diff = branch.riders - riders.reduce((a, b) => a + b, 0);
  if (diff !== 0) riders[1] = (riders[1] || 0) + diff;

  return {
    r1: riders[0] || 0,
    r2: riders[1] || 0,
    r3: riders[2] || 0
  };
}

function ridersAtHour(r1, r2, r3, hour, nShifts, shifts, noShowPct) {
  const eff1 = Math.max(0, Math.floor(r1 * (1 - noShowPct / 100)));
  const eff2 = Math.max(0, Math.floor(r2 * (1 - noShowPct / 100)));
  const eff3 = Math.max(0, Math.floor(r3 * (1 - noShowPct / 100)));

  let n = 0;
  if (nShifts >= 1 && inShift(hour, shifts[0].start, shifts[0].end)) n += eff1;
  if (nShifts >= 2 && inShift(hour, shifts[1].start, shifts[1].end)) n += eff2;
  if (nShifts >= 3 && inShift(hour, shifts[2].start, shifts[2].end)) n += eff3;

  return n;
}

function calculateUTRPerHour(branch, config) {
  const { orderPct, stkOn, stkRate, noShowPct, nShifts, shifts } = config;

  const scaled = scaledPct(branch.orders, orderPct);
  const riders = splitRiders(branch, nShifts, shifts, null);

  return Array.from({ length: 24 }, (_, hour) => {
    const demand = stackedDemand(scaled[hour], stkOn, stkRate);
    const available = ridersAtHour(riders.r1, riders.r2, riders.r3, hour, nShifts, shifts, noShowPct);

    if (available === 0) return demand > 0 ? null : 0;
    return parseFloat((demand / available).toFixed(2));
  });
}

// ============================================================================
// BIGQUERY DATA FETCH - TALABAT MART HYBRID RIDERS
// ============================================================================

function queryBigQueryData(queryDate) {
  try {
    const dateStr = queryDate ? Utilities.formatDate(new Date(queryDate), 'UTC', 'yyyy-MM-dd') : Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');

    const request = {
      query: BIGQUERY_QUERY,
      useLegacySql: false,
      queryParameters: [
        {
          name: 'query_date',
          parameterType: { type: 'DATE' },
          parameterValue: { value: dateStr }
        }
      ],
      maxResults: 1000
    };

    const queryResults = BigQuery.Projects.Queries.query(request, PROJECT_ID);

    if (!queryResults.rows || queryResults.rows.length === 0) {
      Logger.log('⚠️ No data found for date: ' + dateStr);
      return null;
    }

    Logger.log('✅ BigQuery returned ' + queryResults.rows.length + ' rows for ' + dateStr);
    return queryResults.rows;
  } catch (error) {
    Logger.log('❌ BigQuery error: ' + error);
    return null;
  }
}

function transformBigQueryToBranches(rows) {
  try {
    if (!rows || rows.length === 0) return [];

    const branchMap = {};

    // Group data by branch
    rows.forEach(row => {
      const f = row.f;
      const branchName = f[2].v;
      const hour = parseInt(f[1].v);
      const ordersCount = parseInt(f[3].v) || 0;
      const successfulOrders = parseInt(f[4].v) || 0;
      const avgDistance = parseFloat(f[5].v) || 3.5;
      const stackingRate = parseFloat(f[6].v) || 0;
      const activeRiders = parseInt(f[7].v) || 1;

      if (!branchMap[branchName]) {
        branchMap[branchName] = {
          name: branchName,
          riders: 0,
          orders: Array(24).fill(0),
          utr: Array(24).fill(0),
          dist: Array(24).fill(3.5),
          stk: Array(24).fill(0),
          pct: Array(24).fill(0),
          hourlyRiders: Array(24).fill(0)
        };
      }

      // Fill hourly data
      branchMap[branchName].orders[hour] = successfulOrders;
      branchMap[branchName].dist[hour] = avgDistance;
      branchMap[branchName].stk[hour] = stackingRate;
      branchMap[branchName].hourlyRiders[hour] = activeRiders;

      // Calculate UTR
      if (activeRiders > 0) {
        branchMap[branchName].utr[hour] = parseFloat((successfulOrders / activeRiders).toFixed(2));
      }
    });

    // Calculate peak riders and convert to branches array
    const branches = Object.values(branchMap).map(branch => {
      const maxRiders = Math.max(...branch.hourlyRiders.filter(r => r > 0));
      branch.riders = maxRiders || 10;

      // Calculate order percentages
      const totalOrders = branch.orders.reduce((a, b) => a + b, 0) || 1;
      branch.pct = branch.orders.map(o => (o / totalOrders) * 100);

      delete branch.hourlyRiders;
      return branch;
    });

    return branches;
  } catch (error) {
    Logger.log('❌ Transform error: ' + error);
    return [];
  }
}

function autoUpdateFromBigQuery(queryDate) {
  try {
    const rows = queryBigQueryData(queryDate);
    if (!rows) {
      Logger.log('❌ No rows from BigQuery');
      return null;
    }

    const branches = transformBigQueryToBranches(rows);
    if (branches && branches.length > 0) {
      Logger.log('✅ Updated ' + branches.length + ' Talabat Mart branches (Hybrid)');
      saveBranchesToCache(branches, queryDate);
      return branches;
    } else {
      Logger.log('❌ No branches processed');
    }
  } catch (error) {
    Logger.log('❌ Error in autoUpdateFromBigQuery: ' + error);
  }
}

// ============================================================================
// CACHE MANAGEMENT (DATE-AWARE)
// ============================================================================

function saveBranchesToCache(branches, queryDate) {
  const cache = CacheService.getScriptCache();
  const dateStr = queryDate ? Utilities.formatDate(new Date(queryDate), 'UTC', 'yyyy-MM-dd') : Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  const cacheKey = 'branches_' + dateStr;
  cache.put(cacheKey, JSON.stringify({ date: dateStr, data: branches }), 3600); // 1 hour
  Logger.log('💾 Cached ' + branches.length + ' branches for ' + dateStr);
}

function getBranchesFromCache(queryDate) {
  const cache = CacheService.getScriptCache();
  const dateStr = queryDate ? Utilities.formatDate(new Date(queryDate), 'UTC', 'yyyy-MM-dd') : Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  const cacheKey = 'branches_' + dateStr;
  const cached = cache.get(cacheKey);
  if (cached) {
    Logger.log('📦 Using cached data for ' + dateStr);
    return JSON.parse(cached).data;
  }
  return null;
}

// ============================================================================
// DATA FOR CLIENT (PULLS FROM BIGQUERY)
// ============================================================================

function getInitialData(queryDate) {
  Logger.log('🔄 Loading data for date: ' + (queryDate || 'today'));

  // Try cache first
  let branches = getBranchesFromCache(queryDate);

  // If no cache, pull from BigQuery
  if (!branches) {
    Logger.log('📡 Fetching from BigQuery...');
    branches = autoUpdateFromBigQuery(queryDate);
  }

  // Fallback to empty array if still nothing
  if (!branches) {
    branches = [];
  }

  const dateStr = queryDate ? Utilities.formatDate(new Date(queryDate), 'UTC', 'yyyy-MM-dd') : Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');

  return {
    branches: branches,
    queryDate: dateStr,
    defaultShifts: [
      { start: 9, end: 19 },
      { start: 14, end: 24 },
      { start: 20, end: 30 }
    ],
    defaultNShifts: 2
  };
}

// ============================================================================
// SCHEDULED UPDATE HELPER
// ============================================================================

function testUpdateToday() {
  Logger.log('🧪 Testing BigQuery update for TODAY...');
  const result = autoUpdateFromBigQuery(new Date());
  if (result && result.length > 0) {
    Logger.log('✅ Success: ' + result.length + ' Talabat Mart branches loaded');
  } else {
    Logger.log('❌ Failed or no data');
  }
}

function testUpdateYesterday() {
  Logger.log('🧪 Testing BigQuery update for YESTERDAY...');
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const result = autoUpdateFromBigQuery(yesterday);
  if (result && result.length > 0) {
    Logger.log('✅ Success: ' + result.length + ' Talabat Mart branches loaded');
  } else {
    Logger.log('❌ Failed or no data');
  }
}
