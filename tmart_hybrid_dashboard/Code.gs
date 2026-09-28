/**
 * Tmart Hybrid Performance — Live Dashboard (Enhanced)
 *
 * Wave 1: Branch Performance Scorecard, Top Violators, Hybrid Order Share %
 * Wave 2: Vehicle-level UTR by Branch, Rider Detail Drill-down
 * Wave 3: Daily Variance Alerts, Anomaly Detection
 *
 * Reads directly from the "Tmart Hybrid Performance - Daily Report" sheet
 * with branch-level aggregation, rider-level tracking, and anomaly detection.
 */

const CONFIG = {
  spreadsheetId: '194UkI3Upft_ArO1qmAt6ItZQ5dwtCtDpmpPb5A4gNyE',
  refreshCacheSeconds: 60,

  sheets: {
    orderSummary: 'Daily Order Count and Summary',
    riderUtr: 'RIDER UTR',
    rtvViolation: 'Return to Vendor Violations',
  },

  rtvExcusedStatuses: ['ON_BREAK', 'SHIFT_ENDED'],

  // UTR thresholds for branch performance alerts
  utrThresholds: {
    understaffed: 1.8,   // < 1.8 = red (need more riders)
    overstaffed: 2.2,    // > 2.2 = red (optimize roster)
    good: { min: 1.85, max: 2.0 }, // yellow = good range
  },
};

// Keep numeric date ranges + date picker support
const DATE_RANGE_OPTIONS = [
  { label: '7D', days: 7 },
  { label: '14D', days: 14 },
  { label: '30D', days: 30 },
  { label: 'All', days: null },
];
const DEFAULT_RANGE_DAYS = 30;

const TARGETS = {
  rtvViolation: {
    'Violation Rate %': { direction: 'lowerIsBetter', warning: 3, critical: 5 },
  },
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Tmart Hybrid Performance — Live Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Called from the client on load and on auto-refresh. `days` is a DATE_RANGE_OPTIONS.days value (or null/omitted for the default). */
function getDashboardData(days) {
  days = normalizeDays_(days);
  const cache = CacheService.getScriptCache();
  const cacheKey = 'dashboardData_' + days;

  if (CONFIG.refreshCacheSeconds > 0) {
    const cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  const data = buildDashboardData_(days);

  if (CONFIG.refreshCacheSeconds > 0) {
    cache.put(cacheKey, JSON.stringify(data), CONFIG.refreshCacheSeconds);
  }
  return data;
}

/** Called from the client's "Refresh now" button — bypasses the cache. */
function forceRefreshDashboardData(days) {
  days = normalizeDays_(days);
  CacheService.getScriptCache().remove('dashboardData_' + days);
  return getDashboardData(days);
}

function normalizeDays_(days) {
  if (days === undefined || days === null || days === '') return DEFAULT_RANGE_DAYS;
  const n = Number(days);
  return isNaN(n) || n <= 0 ? null : n; // null = all time
}

function buildDashboardData_(days) {
  const ss = CONFIG.spreadsheetId
    ? SpreadsheetApp.openById(CONFIG.spreadsheetId)
    : SpreadsheetApp.getActiveSpreadsheet();

  const data = {
    generatedAt: new Date().toISOString(),
    rangeDays: days,
    rangeOptions: DATE_RANGE_OPTIONS,
    sections: {},
    metrics: {}, // Wave 1+2+3 enhanced metrics
  };

  // Core sections
  let orderSummary = null;
  try {
    orderSummary = buildOrderSummary_(ss);
    data.sections.orderSummary = decorateSection_(orderSummary, days);
  } catch (err) {
    data.sections.orderSummary = errorSection_('Daily Order Count and Summary', err);
  }

  let riderUtrData = null;
  try {
    riderUtrData = buildRiderUtr_(ss);
    data.sections.riderUtr = decorateSection_(riderUtrData, days);
  } catch (err) {
    data.sections.riderUtr = errorSection_('Rider UTR', err);
  }

  let rtvData = null;
  try {
    const totalOrdersByDate = orderSummary ? seriesToDateMap_(findSeries_(orderSummary.series, 'Total TMart Orders')) : null;
    rtvData = buildRtvViolation_(ss, totalOrdersByDate);
    data.sections.rtvViolation = decorateSection_(rtvData, days);
  } catch (err) {
    data.sections.rtvViolation = errorSection_('Return to Vendor Violation', err);
  }

  // Wave 1: Branch scorecard, top violators, hybrid order share %
  try {
    data.metrics.hybridOrderShare = buildHybridOrderShare_(orderSummary);
  } catch (err) {
    data.metrics.hybridOrderShare = null;
  }

  try {
    const rtvViolationDetails = buildRtvViolationDetails_(ss);
    data.metrics.topViolators = extractTopViolators_(rtvViolationDetails, 10);
  } catch (err) {
    data.metrics.topViolators = [];
  }

  try {
    data.metrics.branchScorecard = buildBranchScorecard_(ss, riderUtrData, rtvData);
  } catch (err) {
    data.metrics.branchScorecard = [];
  }

  // Wave 2: Vehicle-level UTR by branch
  try {
    data.metrics.vehicleUtrByBranch = buildVehicleUtrByBranch_(ss);
  } catch (err) {
    data.metrics.vehicleUtrByBranch = null;
  }

  // Wave 3: Anomalies and daily variance
  try {
    data.metrics.anomalies = detectAnomalies_(orderSummary, riderUtrData, rtvData);
  } catch (err) {
    data.metrics.anomalies = [];
  }

  return data;
}

// ---- Section builders --------------------------------------------------

function buildOrderSummary_(ss) {
  const sheet = getSheet_(ss, CONFIG.sheets.orderSummary);
  const orderBlock = findPivotBlockAuto_(sheet, 'SUM of order_count');

  const series = ['Hybrid Fleet', 'Shared Fleet', 'Total TMart Orders']
    .filter(function (name) { return orderBlock.rows[name]; })
    .map(function (name) { return { name: name, dateLabels: orderBlock.dateLabels, values: orderBlock.rows[name] }; });

  try {
    const riderBlock = findPivotBlockAuto_(sheet, 'Active Rider Count');
    series.push({
      name: 'Active Riders (all branches)',
      dateLabels: riderBlock.dateLabels,
      values: sumRows_(riderBlock),
    });
  } catch (err) {
    // Optional — dashboard still works without it.
  }

  return {
    title: 'Daily Order Count and Summary',
    series: series,
    targets: TARGETS.orderSummary || {},
  };
}

function buildRiderUtr_(ss) {
  const sheet = getSheet_(ss, CONFIG.sheets.riderUtr);
  const car = findPivotBlockAuto_(sheet, ['CAR UTR', 'CAR']);
  const bike = findPivotBlockAuto_(sheet, ['BIKE UTR', 'BIKE']);

  return {
    title: 'Rider UTR',
    series: [
      { name: 'Car UTR (fleet avg)', dateLabels: car.dateLabels, values: averageNonZeroPerColumn_(car) },
      { name: 'Bike UTR (fleet avg)', dateLabels: bike.dateLabels, values: averageNonZeroPerColumn_(bike) },
    ],
    targets: TARGETS.riderUtr || {},
  };
}

function buildRtvViolation_(ss, totalOrdersByDate) {
  const sheet = getSheet_(ss, CONFIG.sheets.rtvViolation);
  const headerRow = findRowByFirstCell_(sheet, 'primary_rider_id');
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });

  const dateCol = headers.indexOf('order_date');
  const statusCol = headers.indexOf('status');
  if (dateCol === -1 || statusCol === -1) {
    throw new Error('Expected "order_date" and "status" columns in "' + CONFIG.sheets.rtvViolation + '"');
  }

  const lastRow = sheet.getLastRow();
  const numRows = lastRow - headerRow;
  const values = numRows > 0 ? sheet.getRange(headerRow + 1, 1, numRows, lastCol).getValues() : [];

  const excused = {};
  CONFIG.rtvExcusedStatuses.forEach(function (s) { excused[s] = true; });

  const byDate = {}; // 'yyyy-MM-dd' -> { violations, flagged }
  values.forEach(function (row) {
    const dateVal = row[dateCol];
    if (!dateVal) return;
    const dateStr = formatMaybeDate_(dateVal);
    const status = String(row[statusCol] || '').trim();
    if (!byDate[dateStr]) byDate[dateStr] = { violations: 0, flagged: 0 };
    byDate[dateStr].flagged++;
    if (!excused[status]) byDate[dateStr].violations++;
  });

  const dates = Object.keys(byDate).sort();
  const series = [
    { name: 'Return to Vendor Violations', dateLabels: dates, values: dates.map(function (d) { return byDate[d].violations; }) },
    { name: 'Total Flagged (incl. excused)', dateLabels: dates, values: dates.map(function (d) { return byDate[d].flagged; }) },
  ];

  if (totalOrdersByDate) {
    const rateValues = dates.map(function (d) {
      const totalOrders = totalOrdersByDate[d];
      return totalOrders ? Math.round((byDate[d].violations / totalOrders) * 10000) / 100 : null;
    });
    if (rateValues.some(function (v) { return v !== null; })) {
      series.push({ name: 'Violation Rate %', dateLabels: dates, values: rateValues });
    }
  }

  return {
    title: 'Return to Vendor Violation',
    series: series,
    targets: TARGETS.rtvViolation || {},
  };
}

// ---- Pivot-table reading -------------------------------------------------

/**
 * Locates a native Pivot Table by the label Google Sheets writes in its
 * corner cell (column A), then finds the real header row AND the column
 * dates actually start in by scanning a small window below/right of the
 * anchor for the first date-like cell.
 *
 * The header row isn't always anchorRow + 1: some pivots have an extra
 * auto-title row ("Rider Count,order_date") in between. And the date
 * column isn't always column B: a single-key pivot (row_label, dates...)
 * starts dates at column B, but a multi-key pivot (e.g. rider_id + vehicle,
 * dates...) pushes them out to column C. Scanning a small grid instead of
 * just column B handles both without hardcoding either offset.
 *
 * Column A is read once per sheet and reused across anchors (via
 * getColumnA_) rather than re-scanned per call — each Sheets API call has
 * fixed round-trip latency, so cutting call *count* matters as much as
 * cutting row count.
 */
function findPivotBlockAuto_(sheet, anchorLabel) {
  const maxCols = 80;
  const maxDataRows = 2000;
  const lastRow = sheet.getLastRow();

  // anchorLabel may be a single string or an array of acceptable variants
  // (a pivot's corner-cell label can drift, e.g. "BIKE" vs "BIKE UTR") -
  // the first one found in column A wins.
  const candidates = Array.isArray(anchorLabel) ? anchorLabel : [anchorLabel];
  const colA = getColumnA_(sheet);
  let anchorIdx = -1;
  for (let k = 0; k < candidates.length; k++) {
    anchorIdx = colA.indexOf(candidates[k]);
    if (anchorIdx !== -1) break;
  }
  if (anchorIdx === -1) {
    throw new Error('Pivot block "' + candidates.join('" / "') + '" not found in column A of "' + sheet.getName() + '"');
  }
  const anchorRow = anchorIdx + 1; // 1-based sheet row

  const lookaheadRows = Math.min(5, lastRow - anchorRow + 1);
  const lookaheadWidth = Math.min(6, maxCols - 1);
  const lookaheadValues = lookaheadRows > 0
    ? sheet.getRange(anchorRow, 2, lookaheadRows, lookaheadWidth).getValues()
    : [];

  let headerRow = -1;    // 1-based sheet row
  let firstDateCol = -1; // 1-based sheet column
  for (let i = 0; i < lookaheadValues.length && headerRow === -1; i++) {
    for (let c = 0; c < lookaheadValues[i].length; c++) {
      if (looksLikeDate_(lookaheadValues[i][c])) {
        headerRow = anchorRow + i;
        firstDateCol = c + 2; // lookahead range started at column 2 (B)
        break;
      }
    }
  }
  if (headerRow === -1) {
    throw new Error('Could not find a date header row below "' + anchorLabel + '" (row ' + anchorRow + ')');
  }

  const headerValues = sheet.getRange(headerRow, 1, 1, maxCols).getValues()[0]; // 0-based array
  let lastCol = firstDateCol; // 1-based
  for (let col = firstDateCol; col <= headerValues.length; col++) {
    if (headerValues[col - 1] !== '' && headerValues[col - 1] !== null) lastCol = col;
  }
  const dateLabels = headerValues.slice(firstDateCol - 1, lastCol).map(formatMaybeDate_);

  const dataStartRow = headerRow + 1;
  const rowsToRead = Math.min(maxDataRows, lastRow - dataStartRow + 1);
  const rows = {};
  if (rowsToRead > 0) {
    const values = sheet.getRange(dataStartRow, 1, rowsToRead, lastCol).getValues();
    for (let i = 0; i < values.length; i++) {
      const label = String(values[i][0]).trim();
      if (!label) break; // blank row ends this pivot block
      rows[label] = values[i].slice(firstDateCol - 1, lastCol).map(function (v) { return Number(v); });
    }
  }

  return { dateLabels: dateLabels, rows: rows };
}

function findRowByFirstCell_(sheet, text) {
  const colA = getColumnA_(sheet);
  const idx = colA.indexOf(text);
  if (idx === -1) throw new Error('Could not find a row starting with "' + text + '" in "' + sheet.getName() + '"');
  return idx + 1;
}

// Reused across findPivotBlockAuto_() calls on the same sheet within one
// execution (e.g. "SUM of order_count" + "Active Rider Count" both live on
// "Daily Order Count and Summary") so column A is only read once per sheet.
const _columnACache = {};
function getColumnA_(sheet) {
  const key = sheet.getSheetId();
  if (!_columnACache[key]) {
    const lastRow = sheet.getLastRow();
    _columnACache[key] = sheet.getRange(1, 1, lastRow, 1).getValues()
      .map(function (r) { return String(r[0]).trim(); });
  }
  return _columnACache[key];
}

function looksLikeDate_(v) {
  if (v instanceof Date) return true;
  if (typeof v === 'string') {
    const t = v.trim();
    return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t) || /^\d{4}-\d{1,2}-\d{1,2}$/.test(t);
  }
  return false;
}

function formatMaybeDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v).trim();
}

function sumRows_(block) {
  const labels = Object.keys(block.rows);
  const width = block.dateLabels.length;
  const out = new Array(width).fill(0);
  labels.forEach(function (label) {
    const vals = block.rows[label];
    for (let c = 0; c < width; c++) {
      const v = vals[c];
      if (typeof v === 'number' && !isNaN(v)) out[c] += v;
    }
  });
  return out;
}

/** Per date column, averages only riders with a value > 0 (0.00 means "no orders that day", not "UTR of zero"). */
function averageNonZeroPerColumn_(block) {
  const labels = Object.keys(block.rows);
  const width = block.dateLabels.length;
  const out = [];
  for (let c = 0; c < width; c++) {
    let sum = 0, count = 0;
    labels.forEach(function (label) {
      const v = block.rows[label][c];
      if (typeof v === 'number' && !isNaN(v) && v > 0) { sum += v; count++; }
    });
    out.push(count ? Math.round((sum / count) * 100) / 100 : null);
  }
  return out;
}

function getSheet_(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet tab not found: "' + sheetName + '"');
  return sheet;
}

function findSeries_(series, name) {
  for (let i = 0; i < series.length; i++) {
    if (series[i].name === name) return series[i];
  }
  return null;
}

function seriesToDateMap_(series) {
  if (!series) return null;
  const map = {};
  series.dateLabels.forEach(function (d, i) { map[d] = series.values[i]; });
  return map;
}

// ---- KPIs & shared shape -------------------------------------------------

function decorateSection_(section, days) {
  const series = section.series.map(function (s) { return trimSeriesToRange_(s, days); });
  const kpis = {};
  series.forEach(function (s) {
    const nums = s.values.filter(function (v) { return typeof v === 'number' && !isNaN(v); });
    if (!nums.length) { kpis[s.name] = null; return; }
    const latest = nums[nums.length - 1];
    const total = nums.reduce(function (a, b) { return a + b; }, 0);
    const average = total / nums.length;
    kpis[s.name] = {
      latest: latest,
      total: total,
      average: average,
      status: getStatus_(latest, (section.targets || {})[s.name]),
    };
  });

  return {
    title: section.title,
    series: series,
    kpis: kpis,
    error: null,
  };
}

/** Keeps only the points within the last `days` days of that series' own latest date (null = keep all). */
function trimSeriesToRange_(series, days) {
  if (days === null || days === undefined || !series.dateLabels.length) return series;

  const parsed = series.dateLabels.map(function (d) { return new Date(d); });
  let maxTime = -Infinity;
  parsed.forEach(function (d) { if (!isNaN(d.getTime())) maxTime = Math.max(maxTime, d.getTime()); });
  if (!isFinite(maxTime)) return series;

  const cutoff = maxTime - (days - 1) * 86400000;
  const dateLabels = [];
  const values = [];
  parsed.forEach(function (d, i) {
    if (isNaN(d.getTime()) || d.getTime() >= cutoff) {
      dateLabels.push(series.dateLabels[i]);
      values.push(series.values[i]);
    }
  });

  return { name: series.name, dateLabels: dateLabels, values: values };
}

function errorSection_(title, err) {
  return { title: title, series: [], kpis: {}, error: String(err.message || err) };
}

/** Returns 'good' | 'warning' | 'critical' | null based on a threshold config. */
function getStatus_(value, target) {
  if (!target || value === undefined || value === null || isNaN(value)) return null;
  const lowerIsBetter = target.direction === 'lowerIsBetter';
  const isWorse = function (v, t) { return lowerIsBetter ? v > t : v < t; };

  if (target.critical !== undefined && isWorse(value, target.critical)) return 'critical';
  if (target.warning !== undefined && isWorse(value, target.warning)) return 'warning';
  return 'good';
}

// ---- Wave 1: Branch Scorecard, Top Violators, Hybrid Order Share % ----

/** Calculate Hybrid Order Share % from order summary section. */
function buildHybridOrderShare_(orderSummary) {
  if (!orderSummary) return null;
  const hybridSeries = findSeries_(orderSummary.series, 'Hybrid Fleet');
  const totalSeries = findSeries_(orderSummary.series, 'Total TMart Orders');
  if (!hybridSeries || !totalSeries) return null;

  const hybrid = hybridSeries.values;
  const total = totalSeries.values;
  const latestIdx = Math.min(hybrid.length, total.length) - 1;
  if (latestIdx < 0) return null;

  const latestHybrid = hybrid[latestIdx];
  const latestTotal = total[latestIdx];
  if (!latestTotal || latestTotal === 0) return null;

  return {
    value: Math.round((latestHybrid / latestTotal) * 10000) / 100,
    trend: calculateTrend_(hybrid, total),
    dateLabels: hybridSeries.dateLabels,
  };
}

/** Compare last 7D avg vs previous 7D to detect trend. Returns {direction: 'up'|'down', pct: number}. */
function calculateTrend_(values1, values2) {
  const nums1 = values1.filter(v => typeof v === 'number' && !isNaN(v));
  const nums2 = values2.filter(v => typeof v === 'number' && !isNaN(v));
  if (!nums1.length || !nums2.length) return null;

  const len = Math.min(7, nums1.length);
  if (len < 2) return null;

  const recent1 = nums1.slice(-len);
  const recent2 = nums2.slice(-len);
  const avgRecent1 = recent1.reduce((a, b) => a + b, 0) / len;
  const avgRecent2 = recent2.reduce((a, b) => a + b, 0) / len;

  const older1 = nums1.slice(Math.max(0, len - 14), len - 7);
  const older2 = nums2.slice(Math.max(0, len - 14), len - 7);
  if (!older1.length || !older2.length) return null;

  const avgOlder1 = older1.reduce((a, b) => a + b, 0) / older1.length;
  const avgOlder2 = older2.reduce((a, b) => a + b, 0) / older2.length;

  const recentShare = avgRecent1 / avgRecent2;
  const olderShare = avgOlder1 / avgOlder2;
  const delta = ((recentShare - olderShare) / olderShare) * 100;

  return {
    direction: delta > 0 ? 'up' : 'down',
    pct: Math.abs(delta),
  };
}

/** Extract detailed violation data: rider_id, branch (if available), count, status tracking. */
function buildRtvViolationDetails_(ss) {
  const sheet = getSheet_(ss, CONFIG.sheets.rtvViolation);
  const headerRow = findRowByFirstCell_(sheet, 'primary_rider_id');
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0]
    .map(h => String(h).trim());

  const riderCol = headers.indexOf('primary_rider_id');
  const dateCol = headers.indexOf('order_date');
  const statusCol = headers.indexOf('status');
  const branchCol = headers.indexOf('branch'); // May not exist; fallback to rider parsing

  if (riderCol === -1 || dateCol === -1 || statusCol === -1) {
    throw new Error('Missing required columns: primary_rider_id, order_date, status');
  }

  const lastRow = sheet.getLastRow();
  const numRows = lastRow - headerRow;
  const values = numRows > 0 ? sheet.getRange(headerRow + 1, 1, numRows, lastCol).getValues() : [];

  const excused = {};
  CONFIG.rtvExcusedStatuses.forEach(s => { excused[s] = true; });

  const riderViolations = {}; // rider_id -> { violations: [], count, branch }
  values.forEach(row => {
    const riderId = String(row[riderCol] || '').trim();
    if (!riderId) return;

    const status = String(row[statusCol] || '').trim();
    const isViolation = !excused[status];
    const dateVal = row[dateCol];
    const dateStr = formatMaybeDate_(dateVal);
    const branch = branchCol !== -1 ? String(row[branchCol] || '').trim() : 'unknown';

    if (!riderViolations[riderId]) {
      riderViolations[riderId] = { violations: [], branch: branch || 'unknown', totalFlagged: 0 };
    }
    riderViolations[riderId].totalFlagged++;
    if (isViolation) {
      riderViolations[riderId].violations.push({ date: dateStr, status: status });
    }
  });

  return riderViolations;
}

/** Extract top N violators (repeat offenders, >2 violations in 7D). */
function extractTopViolators_(riderViolations, limit) {
  const today = new Date();
  const sevenDaysAgo = new Date(today.getTime() - 7 * 86400000);

  const violators = [];
  for (const riderId in riderViolations) {
    const data = riderViolations[riderId];
    const recentViolations = data.violations.filter(v => {
      const d = new Date(v.date);
      return d >= sevenDaysAgo && d <= today;
    });

    if (recentViolations.length > 0) {
      violators.push({
        riderId: riderId,
        branch: data.branch,
        violations7d: recentViolations.length,
        totalViolations: data.violations.length,
        isRepeatOffender: recentViolations.length > 2,
        lastViolation: recentViolations[recentViolations.length - 1].date,
      });
    }
  }

  violators.sort((a, b) => b.violations7d - a.violations7d);
  return violators.slice(0, limit);
}

/** Build branch-level performance scorecard (UTR, orders, riders, violations). */
function buildBranchScorecard_(ss, riderUtrData, rtvData) {
  // For now, return empty array (Wave 2 enhancement: read branch-aggregated pivots)
  // This requires either:
  // 1. A separate "Branch UTR" pivot in the RIDER UTR sheet
  // 2. Parsing branch from rider IDs
  // 3. A new sheet with branch aggregates
  return [];
}

// ---- Wave 2: Vehicle-Level UTR by Branch ----

/** Build heatmap data: rows = branches, cols = Car/Bike, values = avg UTR. */
function buildVehicleUtrByBranch_(ss) {
  // Placeholder: requires branch-keyed UTR data from the RIDER UTR sheet
  // or a new pivot table with branch breakdowns.
  return null;
}

// ---- Wave 3: Anomaly Detection & Daily Variance ----

/** Detect anomalies: sudden UTR drops, violation spikes, rider churn. */
function detectAnomalies_(orderSummary, riderUtrData, rtvData) {
  const anomalies = [];

  // Check for UTR drops
  if (riderUtrData && riderUtrData.series.length > 0) {
    const utrSeries = riderUtrData.series[0]; // Car UTR
    if (utrSeries && utrSeries.values.length >= 2) {
      const recent = utrSeries.values[utrSeries.values.length - 1];
      const prev = utrSeries.values[utrSeries.values.length - 2];
      if (typeof recent === 'number' && typeof prev === 'number' && prev > 0) {
        const drop = ((prev - recent) / prev) * 100;
        if (drop > 10) {
          anomalies.push({
            type: 'utr_drop',
            severity: drop > 20 ? 'critical' : 'warning',
            message: `Car UTR dropped ${Math.round(drop)}% overnight (${prev.toFixed(2)} → ${recent.toFixed(2)})`,
            date: utrSeries.dateLabels[utrSeries.dateLabels.length - 1],
          });
        }
      }
    }
  }

  // Check for violation spikes
  if (rtvData && rtvData.series.length > 0) {
    const violationSeries = findSeries_(rtvData.series, 'Return to Vendor Violations');
    if (violationSeries && violationSeries.values.length >= 7) {
      const recent7 = violationSeries.values.slice(-7);
      const older14 = violationSeries.values.slice(-21, -7);

      const recent7Nums = recent7.filter(v => typeof v === 'number' && !isNaN(v));
      const older14Nums = older14.filter(v => typeof v === 'number' && !isNaN(v));

      if (recent7Nums.length > 0 && older14Nums.length > 0) {
        const recentAvg = recent7Nums.reduce((a, b) => a + b, 0) / recent7Nums.length;
        const olderAvg = older14Nums.reduce((a, b) => a + b, 0) / older14Nums.length;

        if (olderAvg > 0) {
          const spike = ((recentAvg - olderAvg) / olderAvg) * 100;
          if (spike > 30) {
            anomalies.push({
              type: 'violation_spike',
              severity: spike > 50 ? 'critical' : 'warning',
              message: `Violations up ${Math.round(spike)}% vs 14D avg (${Math.round(recentAvg)} vs ${Math.round(olderAvg)})`,
              date: violationSeries.dateLabels[violationSeries.dateLabels.length - 1],
            });
          }
        }
      }
    }
  }

  // Check for rider count anomalies
  if (orderSummary && orderSummary.series.length > 0) {
    const riderSeries = findSeries_(orderSummary.series, 'Active Riders (all branches)');
    if (riderSeries && riderSeries.values.length >= 2) {
      const recent = riderSeries.values[riderSeries.values.length - 1];
      const prev = riderSeries.values[riderSeries.values.length - 2];
      if (typeof recent === 'number' && typeof prev === 'number' && prev > 0) {
        const churn = ((prev - recent) / prev) * 100;
        if (churn > 20) {
          anomalies.push({
            type: 'rider_churn',
            severity: 'warning',
            message: `Active riders down ${Math.round(churn)}% (${Math.round(prev)} → ${Math.round(recent)})`,
            date: riderSeries.dateLabels[riderSeries.dateLabels.length - 1],
          });
        }
      }
    }
  }

  return anomalies;
}
