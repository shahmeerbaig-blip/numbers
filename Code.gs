// ============================================================================
// TALABAT SHIFT PLANNING DASHBOARD - GOOGLE APPS SCRIPT BACKEND
// ============================================================================

// Default branch data
const DEFAULT_BRANCHES = [
  {name:'Muntazah', riders:29,
   orders:[52.5,33.7,20.7,14.2,13.8,29.1,36.4,57.5,76.5,90.3,117.6,128.3,131.8,127.0,127.3,136.8,141.1,148.3,162.3,166.3,157.0,127.5,102.5,74.0],
   utr:[null,null,null,null,null,null,null,null,null,8.03,4.36,4.49,4.67,4.68,4.70,4.98,5.07,5.23,5.96,6.91,13.83,26.83,47.70,67.23],
   dist:[3.71,3.8,3.79,3.82,3.86,3.51,3.75,3.86,3.76,3.92,3.42,3.42,3.37,3.46,3.37,3.53,3.58,3.66,3.63,3.59,3.55,3.54,3.61,3.64],
   stk:[0.026,0.016,0.003,0.018,0.007,0.007,0.003,0.003,0.014,0.038,0.082,0.101,0.144,0.197,0.137,0.101,0.043,0.038,0.039,0.117,0.192,0.168,0.084,0.020],
   pct:[2.31,1.48,0.91,0.62,0.61,1.28,1.60,2.53,3.37,3.97,5.18,5.65,5.80,5.59,5.60,6.02,6.21,6.52,7.14,7.32,6.91,5.61,4.51,3.25]},
  {name:'Bin Omran', riders:17,
   orders:[32.6,19.1,13.3,8.8,7.1,16.5,24.3,38.3,47.5,53.6,66.9,75.2,72.2,75.6,73.8,75.3,83.0,87.4,97.2,100.5,94.3,79.9,59.1,44.3],
   utr:[null,null,null,null,null,null,null,null,null,8.87,4.78,4.80,4.50,4.42,4.46,4.92,5.00,5.25,5.91,6.59,12.58,21.59,40.76,null],
   dist:[3.68,3.44,3.39,3.2,3.56,3.48,3.55,3.73,3.73,3.53,7.78,3.43,3.44,3.44,3.47,3.56,3.55,3.55,3.53,3.52,3.62,3.6,3.58,3.53],
   stk:[0.006,0.000,0.000,0.011,0.000,0.006,0.004,0.034,0.081,0.111,0.152,0.130,0.177,0.176,0.087,0.076,0.052,0.046,0.054,0.068,0.079,0.049,0.014,0.003],
   pct:[2.42,1.42,0.99,0.65,0.53,1.22,1.81,2.85,3.53,3.99,4.97,5.59,5.36,5.62,5.49,5.60,6.16,6.50,7.22,7.47,7.01,5.94,4.39,3.29]},
  {name:'Abu Hamour', riders:12,
   orders:[14.4,8.2,5.3,3.5,3.8,6.3,10.5,12.4,16.4,21.8,28.4,34.8,34.6,36.7,36.2,36.0,37.0,41.0,49.5,47.1,44.3,39.8,30.1,22.3],
   utr:[null,null,null,null,null,null,null,null,null,4.73,2.83,3.22,3.15,3.19,3.16,3.29,3.27,3.65,4.40,4.26,7.50,13.71,null,null],
   dist:[2.43,2.28,2.58,2.52,2.79,2.75,2.59,2.5,2.55,2.38,2.28,2.28,2.44,2.35,2.42,2.51,2.45,2.5,2.48,2.36,2.41,2.42,2.39,2.5],
   stk:[0.015,0.000,0.000,0.032,0.000,0.016,0.000,0.008,0.000,0.023,0.055,0.106,0.098,0.110,0.113,0.072,0.055,0.048,0.073,0.054,0.101,0.101,0.066,0.004],
   pct:[2.32,1.32,0.85,0.56,0.60,1.02,1.69,2.01,2.65,3.51,4.57,5.60,5.58,5.92,5.84,5.81,5.96,6.62,7.98,7.60,7.14,6.41,4.85,3.59]},
  {name:'Al Wakrah', riders:12,
   orders:[31.1,18.7,13.4,8.1,8.9,18.9,22.1,25.1,35.5,47.2,61.6,64.8,71.3,69.8,68.9,70.4,70.0,80.0,91.3,102.5,99.0,85.5,66.9,46.2],
   utr:[null,null,null,null,null,null,null,null,null,13.88,6.29,6.79,7.28,6.04,6.02,5.82,5.81,6.56,7.48,8.77,20.40,22.50,23.47,20.53],
   dist:[4.93,4.69,4.79,4.82,5.05,4.93,4.75,4.72,4.76,4.51,4.51,4.55,4.61,4.4,4.53,4.52,4.49,4.59,4.61,4.58,4.63,4.52,4.62,4.88],
   stk:[0.007,0.000,0.008,0.000,0.011,0.024,0.009,0.000,0.008,0.010,0.024,0.030,0.047,0.034,0.022,0.028,0.015,0.023,0.026,0.022,0.013,0.012,0.012,0.006],
   pct:[2.44,1.46,1.05,0.63,0.70,1.48,1.73,1.97,2.78,3.70,4.83,5.08,5.59,5.46,5.39,5.51,5.48,6.26,7.14,8.03,7.75,6.69,5.24,3.62]},
  {name:'Lusail', riders:14,
   orders:[25.9,15.6,9.7,6.0,6.3,16.6,23.8,35.3,42.4,54.3,67.0,72.7,74.8,78.8,80.6,83.0,86.2,89.9,96.1,104.0,98.5,78.8,60.8,42.1],
   utr:[null,null,null,null,null,null,null,null,null,6.75,5.33,5.47,5.54,5.84,6.04,6.36,6.70,7.52,8.11,9.59,21.65,45.06,null,null],
   dist:[6.34,6,6.59,6.92,6.33,6.56,6.89,6.37,6.32,6.31,5.85,6.07,5.96,6.12,6.23,6.37,6.45,6.71,6.7,6.61,6.43,6.82,6.4,6],
   stk:[0.004,0.000,0.022,0.000,0.016,0.012,0.004,0.014,0.057,0.060,0.042,0.039,0.034,0.023,0.012,0.009,0.009,0.003,0.011,0.009,0.008,0.010,0.010,0.005],
   pct:[1.92,1.15,0.72,0.45,0.47,1.23,1.76,2.61,3.14,4.02,4.96,5.39,5.54,5.84,5.97,6.15,6.38,6.66,7.12,7.71,7.30,5.84,4.50,3.12]},
];

// ============================================================================
// SERVE THE HTML UI
// ============================================================================
function doGet() {
  return HtmlService.createHtmlOutput(getHTML())
    .setWidth(1600)
    .setHeight(900)
    .setSandboxMode(HtmlService.SandboxMode.IFRAME);
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
// DATA PERSISTENCE
// ============================================================================

function getOrCreateSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Dashboard Data');
  if (!sheet) {
    sheet = ss.insertSheet('Dashboard Data');
    sheet.hideSheet();
  }
  return sheet;
}

function saveBranchConfig(branchName, config) {
  const sheet = getOrCreateSheet();
  const data = JSON.stringify(config);

  let range = sheet.getRange('A1:B1000');
  const values = range.getValues();

  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === branchName) {
      sheet.getRange(i + 1, 2).setValue(data);
      return;
    }
  }

  // Add new entry
  const lastRow = sheet.getLastRow() + 1;
  sheet.getRange(lastRow, 1).setValue(branchName);
  sheet.getRange(lastRow, 2).setValue(data);
}

function loadBranchConfig(branchName) {
  const sheet = getOrCreateSheet();
  const range = sheet.getRange('A1:B1000');
  const values = range.getValues();

  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === branchName) {
      try {
        return JSON.parse(values[i][1]);
      } catch (e) {
        return null;
      }
    }
  }
  return null;
}

// ============================================================================
// SERVER-SIDE CALCULATIONS FOR TABLE
// ============================================================================

function calculateBranchMetrics(branch, config) {
  const { orderPct, stkOn, stkRate, noShowPct, nShifts, shifts } = config;

  const scaled = scaledPct(branch.orders, orderPct);
  const riders = splitRiders(branch, nShifts, shifts, null);

  const hourlyUTR = calculateUTRPerHour(branch, config);

  // Coverage calculations
  const coveredOrders = Array.from({ length: 24 }, (_, hour) => {
    const demand = scaled[hour];
    const available = ridersAtHour(riders.r1, riders.r2, riders.r3, hour, nShifts, shifts, noShowPct);
    return Math.min(demand, available * (hourlyUTR[hour] || 0));
  });

  const totalOrders = scaled.reduce((a, b) => a + b, 0);
  const totalCovered = coveredOrders.reduce((a, b) => a + b, 0);
  const coverage = totalOrders > 0 ? parseFloat(((totalCovered / totalOrders) * 100).toFixed(1)) : 0;

  const peakUTR = Math.max(...hourlyUTR.filter(u => u !== null));
  const avgUTR = hourlyUTR.filter(u => u !== null).reduce((a, b) => a + b, 0) / hourlyUTR.filter(u => u !== null).length;
  const stackedPeakUTR = stackedUTR(peakUTR, stkOn, stkRate);

  return {
    r1: riders.r1,
    r2: riders.r2,
    r3: riders.r3,
    total: riders.r1 + riders.r2 + riders.r3,
    dailyAvgOrders: parseFloat((totalOrders / 24).toFixed(1)),
    coveredOrders: parseFloat(totalCovered.toFixed(1)),
    uncovered: parseFloat((totalOrders - totalCovered).toFixed(1)),
    coverage,
    peakUTR: parseFloat(peakUTR.toFixed(2)),
    stackedPeakUTR: parseFloat(stackedPeakUTR.toFixed(2)),
    avgUTR: parseFloat(avgUTR.toFixed(2)),
    hourlyUTR
  };
}

// ============================================================================
// DATA FOR CLIENT
// ============================================================================

function getInitialData() {
  return {
    branches: DEFAULT_BRANCHES,
    defaultShifts: [
      { start: 9, end: 19 },
      { start: 14, end: 24 },
      { start: 20, end: 30 }
    ],
    defaultNShifts: 2
  };
}

// ============================================================================
// CSV UPLOAD HANDLER
// ============================================================================

function processCSV(csvData) {
  const rows = csvData.split('\n').filter(row => row.trim());
  if (rows.length < 2) return null;

  const headers = rows[0].split(',').map(h => h.trim().toLowerCase());
  const branches = [];

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i].split(',').map(c => c.trim());
    if (cells.length < 3) continue;

    const branchName = cells[0];
    const riders = parseInt(cells[1]) || 10;
    const dailyOrders = parseFloat(cells[2]) || 100;

    // Create branch with default pattern
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
// GOOGLE SHEETS AUTO-UPDATE
// ============================================================================

function generateCSVFromSheet() {
  try {
    // Open the Google Sheet with branch data
    const spreadsheet = SpreadsheetApp.openById('1EIU9d8p1HMxoWs0U9Y1W708QdUm5vhaVXE2mQEJ9Dds');

    // Get the first sheet (you can change the index or name)
    const sheet = spreadsheet.getSheets()[0];
    const data = sheet.getDataRange().getValues();

    if (data.length < 2) {
      Logger.log('Sheet is empty');
      return null;
    }

    // Convert to CSV format (expecting: Branch Name, Riders, Daily Avg Orders)
    let csv = 'Branch Name,Riders,Daily Avg Orders\n';
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][1] && data[i][2]) {
        csv += `${data[i][0]},${data[i][1]},${data[i][2]}\n`;
      }
    }

    Logger.log('Generated CSV from sheet');
    return csv;
  } catch (error) {
    Logger.log('Error reading sheet: ' + error);
    return null;
  }
}

function autoUpdateFromSource() {
  try {
    const csvData = generateCSVFromSheet();

    if (!csvData) {
      Logger.log('No CSV data generated');
      return;
    }

    const branches = processCSV(csvData);

    if (branches && branches.length > 0) {
      Logger.log('✅ Updated ' + branches.length + ' branches from Google Sheet');
      return branches;
    } else {
      Logger.log('No branches processed');
    }
  } catch (error) {
    Logger.log('Error in autoUpdateFromSource: ' + error);
  }
}
