/**
 * Tmart Hybrid Performance — Live Dashboard
 *
 * Reads directly from the "Tmart Hybrid Performance - Daily Report" sheet
 * every time the dashboard is opened or refreshed (short cache below), so
 * it reflects whatever the connected BigQuery pivots currently show.
 *
 * Matched against the real tabs in that sheet:
 *   - "Daily Order Count and Summary" — native Pivot Tables stacked in one
 *     tab (SUM of order_count by fleet_type, Active Rider Count by vendor,
 *     Car/Bike UTR by zone, per-rider order counts, ...).
 *   - "RIDER UTR"                     — per-rider CAR UTR / BIKE pivots.
 *   - "Return to Vendor Violations"   — flat list of flagged rider gaps
 *     (primary_rider_id, vehicle, order_id, order_date, ..., status, vendor)
 *     awaiting location-check confirmation (vendor is always
 *     "PENDING_LOCATION" as of this writing — there's no separate
 *     confirmed/violation flag yet).
 *
 * Because these are native Pivot Tables, their row order and column count
 * (dates) shift over time as new days/vendors/riders appear — so instead of
 * fixed A1 ranges, findPivotBlockAuto_() locates each block by the literal
 * label Google Sheets writes in its corner cell (e.g. "SUM of order_count"),
 * then detects the real header row by finding the first row below it whose
 * column B looks like a date. Adjust the anchor strings below only if your
 * pivot's corner-cell label differs.
 *
 * SETUP
 * 1. Open the target Google Sheet -> Extensions -> Apps Script.
 * 2. Create/replace "Code.gs" with this file, and "index.html" with the
 *    companion HTML file, in the same Apps Script project.
 * 3. Deploy -> New deployment -> Web app -> Execute as: Me, Who has access:
 *    your choice (e.g. "Anyone within Talabat"). Open the resulting URL.
 * 4. Re-run "Deploy -> Manage deployments -> Edit -> New version" whenever
 *    you edit the script, so the live URL picks up your changes.
 */

const CONFIG = {
  // Leave '' to read from the spreadsheet this script is bound to.
  spreadsheetId: '',

  // How long a dashboard read is cached before the next open/refresh
  // re-reads the sheet. Set to 0 to always read live (no caching).
  refreshCacheSeconds: 60,

  sheets: {
    orderSummary: 'Daily Order Count and Summary',
    riderUtr: 'RIDER UTR',
    rtvViolation: 'Return to Vendor Violations',
  },

  // Status values on the RTV sheet that mean the gap was excused (rider was
  // on an authorized break or their shift had ended) — everything else
  // (45MIN+_GAP, 30-45MIN_GAP, 15-30MIN_GAP, ...) counts as a violation.
  rtvExcusedStatuses: ['ON_BREAK', 'SHIFT_ENDED'],
};

// Optional compliance thresholds, used to color a KPI tile's status dot.
// direction: 'lowerIsBetter' means values ABOVE the threshold are bad.
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

/** Called from the client on load and on auto-refresh. */
function getDashboardData() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'dashboardData';

  if (CONFIG.refreshCacheSeconds > 0) {
    const cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  const data = buildDashboardData_();

  if (CONFIG.refreshCacheSeconds > 0) {
    cache.put(cacheKey, JSON.stringify(data), CONFIG.refreshCacheSeconds);
  }
  return data;
}

/** Called from the client's "Refresh now" button — bypasses the cache. */
function forceRefreshDashboardData() {
  CacheService.getScriptCache().remove('dashboardData');
  return getDashboardData();
}

function buildDashboardData_() {
  const ss = CONFIG.spreadsheetId
    ? SpreadsheetApp.openById(CONFIG.spreadsheetId)
    : SpreadsheetApp.getActiveSpreadsheet();

  const data = { generatedAt: new Date().toISOString(), sections: {} };

  let orderSummary = null;
  try {
    orderSummary = buildOrderSummary_(ss);
    data.sections.orderSummary = decorateSection_(orderSummary);
  } catch (err) {
    data.sections.orderSummary = errorSection_('Daily Order Count and Summary', err);
  }

  try {
    data.sections.riderUtr = decorateSection_(buildRiderUtr_(ss));
  } catch (err) {
    data.sections.riderUtr = errorSection_('Rider UTR', err);
  }

  try {
    const totalOrdersByDate = orderSummary ? seriesToDateMap_(findSeries_(orderSummary.series, 'Total TMart Orders')) : null;
    data.sections.rtvViolation = decorateSection_(buildRtvViolation_(ss, totalOrdersByDate));
  } catch (err) {
    data.sections.rtvViolation = errorSection_('Return to Vendor Violation', err);
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
  const car = findPivotBlockAuto_(sheet, 'CAR UTR');
  const bike = findPivotBlockAuto_(sheet, 'BIKE');

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
 * corner cell (column A), then finds the real header row by scanning up to
 * 4 rows below for the first one whose column B looks like a date — this
 * absorbs the extra "Rider Count,order_date" auto-title row some pivots
 * have between the label and the header, without hardcoding an offset.
 */
function findPivotBlockAuto_(sheet, anchorLabel) {
  const maxCols = 80;
  const maxDataRows = 2000;
  const lastRow = sheet.getLastRow();

  const colA = sheet.getRange(1, 1, lastRow, 1).getValues();
  let anchorRow = -1;
  for (let i = 0; i < colA.length; i++) {
    if (String(colA[i][0]).trim() === anchorLabel) { anchorRow = i + 1; break; }
  }
  if (anchorRow === -1) {
    throw new Error('Pivot block "' + anchorLabel + '" not found in column A of "' + sheet.getName() + '"');
  }

  let headerRow = -1;
  for (let r = anchorRow; r <= anchorRow + 4 && r <= lastRow; r++) {
    if (looksLikeDate_(sheet.getRange(r, 2).getValue())) { headerRow = r; break; }
  }
  if (headerRow === -1) {
    throw new Error('Could not find a date header row below "' + anchorLabel + '" (row ' + anchorRow + ')');
  }

  const headerValues = sheet.getRange(headerRow, 1, 1, maxCols).getValues()[0];
  let lastCol = 1;
  for (let c = 1; c < headerValues.length; c++) {
    if (headerValues[c] !== '' && headerValues[c] !== null) lastCol = c + 1;
  }
  const dateLabels = headerValues.slice(1, lastCol).map(formatMaybeDate_);

  const dataStartRow = headerRow + 1;
  const rowsToRead = Math.min(maxDataRows, lastRow - dataStartRow + 1);
  const rows = {};
  if (rowsToRead > 0) {
    const values = sheet.getRange(dataStartRow, 1, rowsToRead, lastCol).getValues();
    for (let i = 0; i < values.length; i++) {
      const label = String(values[i][0]).trim();
      if (!label) break; // blank row ends this pivot block
      rows[label] = values[i].slice(1, lastCol).map(function (v) { return Number(v); });
    }
  }

  return { dateLabels: dateLabels, rows: rows };
}

function findRowByFirstCell_(sheet, text) {
  const lastRow = sheet.getLastRow();
  const colA = sheet.getRange(1, 1, lastRow, 1).getValues();
  for (let i = 0; i < colA.length; i++) {
    if (String(colA[i][0]).trim() === text) return i + 1;
  }
  throw new Error('Could not find a row starting with "' + text + '" in "' + sheet.getName() + '"');
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

function decorateSection_(section) {
  const kpis = {};
  section.series.forEach(function (s) {
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
    series: section.series,
    kpis: kpis,
    error: null,
  };
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
