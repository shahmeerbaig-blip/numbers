/**
 * Tmart Hybrid Performance — Live Dashboard
 *
 * Reads directly from the sheet tabs below every time the dashboard is opened
 * or refreshed, so it always reflects whatever your connected SQL/BigQuery
 * ranges currently show — no separate copy of the data is stored anywhere
 * except the short-lived cache described below.
 *
 * SETUP
 * 1. Open the target Google Sheet -> Extensions -> Apps Script.
 * 2. Create/replace "Code.gs" with this file, and "index.html" with the
 *    companion HTML file, in the same Apps Script project.
 * 3. Edit CONFIG below: set each section's sheetName + range to match your
 *    actual tabs, and valueCols to the column headers you want on the
 *    dashboard (must match the header text in row 1 of that range exactly).
 * 4. Deploy -> New deployment -> Web app -> Execute as: Me, Who has access:
 *    your choice (e.g. "Anyone within Talabat"). Open the resulting URL.
 * 5. Re-run "Deploy -> Manage deployments -> Edit -> New version" whenever
 *    you edit the script, so the live URL picks up your changes.
 */

const CONFIG = {
  // Leave '' to read from the spreadsheet this script is bound to.
  // Set to a specific ID if this script is standalone (not container-bound).
  spreadsheetId: '',

  // How long a dashboard read is cached before the next open/refresh
  // re-reads the sheet. Set to 0 to always read live (no caching).
  refreshCacheSeconds: 60,

  sections: {
    orderSummary: {
      title: 'Daily Order Count and Summary',
      sheetName: 'Daily Order Summary',   // TODO: set to your actual tab name
      range: 'A1:F60',                    // TODO: header row + data rows
      dateCol: 'Date',                    // TODO: exact header text of the date column
      valueCols: ['Total Orders', 'Hybrid Orders', 'Shared Orders'], // TODO
      targets: {},
    },

    riderUtr: {
      title: 'Rider UTR',
      sheetName: 'Rider UTR',             // TODO
      range: 'A1:F60',                    // TODO
      dateCol: 'Date',                    // TODO
      valueCols: ['Bike UTR', 'Car UTR'], // TODO
      targets: {},
    },

    rtvViolation: {
      title: 'Return to Vendor Violation',
      sheetName: 'Return to Vendor Violation', // TODO
      range: 'A1:F60',                         // TODO
      dateCol: 'Date',                         // TODO
      valueCols: ['Violations', 'Violation Rate %'], // TODO
      // Optional compliance thresholds per column, used to color that KPI tile.
      // direction: 'lowerIsBetter' means values ABOVE the threshold are bad.
      targets: {
        'Violation Rate %': { direction: 'lowerIsBetter', warning: 3, critical: 5 },
      },
    },
  },
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Tmart Hybrid Performance — Live Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Called from the client on load and on manual/auto refresh. */
function getDashboardData() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'dashboardData';

  if (CONFIG.refreshCacheSeconds > 0) {
    const cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }

  const data = {
    generatedAt: new Date().toISOString(),
    sections: {},
  };

  Object.keys(CONFIG.sections).forEach(function (key) {
    data.sections[key] = buildSection_(key);
  });

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

function buildSection_(key) {
  const cfg = CONFIG.sections[key];
  try {
    const table = readTable_(cfg.sheetName, cfg.range);
    const valueCols = cfg.valueCols.filter(function (c) {
      return table.headers.indexOf(c) !== -1;
    });
    const kpis = computeKpis_(table.rows, valueCols, cfg.targets || {});

    return {
      title: cfg.title,
      dateCol: cfg.dateCol,
      valueCols: valueCols,
      rows: table.rows.map(function (r) {
        const out = {};
        out[cfg.dateCol] = r[cfg.dateCol];
        valueCols.forEach(function (c) { out[c] = r[c]; });
        return out;
      }),
      kpis: kpis,
      error: null,
    };
  } catch (err) {
    return {
      title: cfg.title,
      dateCol: cfg.dateCol,
      valueCols: [],
      rows: [],
      kpis: {},
      error: String(err.message || err),
    };
  }
}

/** Reads a header row + data rows from a sheet range into an array of objects. */
function readTable_(sheetName, range) {
  const ss = CONFIG.spreadsheetId
    ? SpreadsheetApp.openById(CONFIG.spreadsheetId)
    : SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet tab not found: "' + sheetName + '"');

  const values = sheet.getRange(range).getValues();
  const headers = values[0].map(function (h) { return String(h).trim(); });
  const tz = Session.getScriptTimeZone();

  const rows = values.slice(1)
    .filter(function (row) {
      return row.some(function (cell) { return cell !== '' && cell !== null; });
    })
    .map(function (row) {
      const obj = {};
      headers.forEach(function (h, i) {
        let v = row[i];
        if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
        obj[h] = v;
      });
      return obj;
    });

  return { headers: headers, rows: rows };
}

/** Latest/total/average per numeric column, plus an optional compliance status. */
function computeKpis_(rows, valueCols, targets) {
  const kpis = {};
  valueCols.forEach(function (col) {
    const nums = rows
      .map(function (r) { return Number(r[col]); })
      .filter(function (n) { return !isNaN(n); });
    if (!nums.length) return;

    const latest = nums[nums.length - 1];
    const total = nums.reduce(function (a, b) { return a + b; }, 0);
    const average = total / nums.length;

    kpis[col] = {
      latest: latest,
      total: total,
      average: average,
      status: getStatus_(latest, targets[col]),
    };
  });
  return kpis;
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
