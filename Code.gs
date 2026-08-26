// ============================================================================
// TALABAT SHIFT PLANNING DASHBOARD - GOOGLE APPS SCRIPT (FULLY AUTOMATED)
// ============================================================================

// Google Sheet Configuration
const SHEET_ID = '1EIU9d8p1HMxoWs0U9Y1W708QdUm5vhaVXE2mQEJ9Dds';

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
// GOOGLE SHEETS AUTO-UPDATE - FULLY AUTOMATED
// ============================================================================

function generateCSVFromSheet() {
  try {
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    const sheet = spreadsheet.getSheets()[0];
    const data = sheet.getDataRange().getValues();

    if (data.length < 2) {
      Logger.log('❌ Sheet is empty');
      return null;
    }

    // Convert to CSV format (expecting: Branch Name, Riders, Daily Avg Orders)
    let csv = 'Branch Name,Riders,Daily Avg Orders\n';
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][1] && data[i][2]) {
        csv += `${data[i][0]},${data[i][1]},${data[i][2]}\n`;
      }
    }

    Logger.log('✅ Generated CSV from sheet: ' + (data.length - 1) + ' rows');
    return csv;
  } catch (error) {
    Logger.log('❌ Error reading sheet: ' + error);
    return null;
  }
}

function autoUpdateFromSource() {
  try {
    const csvData = generateCSVFromSheet();

    if (!csvData) {
      Logger.log('❌ No CSV data generated');
      return null;
    }

    const branches = processCSV(csvData);

    if (branches && branches.length > 0) {
      Logger.log('✅ Updated ' + branches.length + ' branches from Google Sheet');
      saveBranchesToCache(branches);
      return branches;
    } else {
      Logger.log('❌ No branches processed');
    }
  } catch (error) {
    Logger.log('❌ Error in autoUpdateFromSource: ' + error);
  }
}

// ============================================================================
// CSV PROCESSING
// ============================================================================

function processCSV(csvData) {
  const rows = csvData.split('\n').filter(row => row.trim());
  if (rows.length < 2) return null;

  const branches = [];

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i].split(',').map(c => c.trim());
    if (cells.length < 3) continue;

    const branchName = cells[0];
    const riders = parseInt(cells[1]) || 10;
    const dailyOrders = parseFloat(cells[2]) || 100;

    const branch = {
      name: branchName,
      riders,
      orders: Array(24).fill(dailyOrders / 24),
      utr: Array(24).fill(null),
      dist: Array(24).fill(3.5),
      stk: Array(24).fill(0.05),
      pct: Array(24).fill((dailyOrders / 24) / riders)
    };

    branches.push(branch);
  }

  return branches;
}

// ============================================================================
// CACHE MANAGEMENT
// ============================================================================

function saveBranchesToCache(branches) {
  const cache = CacheService.getScriptCache();
  cache.put('branches', JSON.stringify(branches), 3600); // 1 hour
}

function getBranchesFromCache() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('branches');
  if (cached) {
    return JSON.parse(cached);
  }
  return null;
}

// ============================================================================
// DATA FOR CLIENT (PULLS FROM GOOGLE SHEET)
// ============================================================================

function getInitialData() {
  // Try cache first
  let branches = getBranchesFromCache();

  // If no cache, pull from sheet
  if (!branches) {
    const csvData = generateCSVFromSheet();
    if (csvData) {
      branches = processCSV(csvData);
      if (branches && branches.length > 0) {
        saveBranchesToCache(branches);
      }
    }
  }

  // Fallback to empty array if still nothing
  if (!branches) {
    branches = [];
  }

  return {
    branches: branches,
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

function testUpdate() {
  Logger.log('Testing auto-update...');
  autoUpdateFromSource();
}
