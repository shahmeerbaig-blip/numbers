/**
 * Live Order Tracker refresh endpoint — owned by whoever has BigQuery read
 * access to fulfillment-dwh-production.curated_data_shared_data_stream, and
 * who set up the "Live orders potential fraud signals" Google Sheet's
 * Connected Sheet to BigQuery. NOT part of the main fraud-dashboard script
 * (apps_script_dashboard/Code.gs) — lives in its own Apps Script project
 * bound to that Sheet, so refreshing always runs under the Sheet owner's own
 * BigQuery credentials, never the fraud-dashboard viewer's (who has no
 * access to that dataset — that's the whole reason this is a separate
 * script calling a separate URL).
 *
 * Confirmed 2026-11-26: the Sheet's live-orders tab (name may change on the
 * Sheet owner's side independently of this script - see LIVE_ORDERS_SHEET_TAB
 * in the main dashboard's Code.gs) is fed via a native Connected Sheet to
 * BigQuery (a "Connected Sheet 1" tab holds the raw connection), so
 * refreshing it is just re-running Google's own BigQuery data source — no
 * need to re-implement the query here.
 *
 * SETUP:
 *   1. Open the Google Sheet > Extensions > Apps Script. Paste this in.
 *   2. Pick your own REFRESH_KEY below (any random string) - share only
 *      with the fraud dashboard owner, not publicly.
 *   3. Deploy > New deployment > Web app.
 *        Execute as: Me  <- refresh always runs under YOUR BigQuery access
 *        Who has access: Anyone
 *   4. Send the dashboard owner the deployed /exec URL and your REFRESH_KEY.
 *   5. Optional backstop: Triggers > Add Trigger > refreshLiveOrders >
 *      time-driven > every 2-5 min, so the sheet stays fresh even if nobody
 *      searches Live Order Tracker for a while.
 */

var REFRESH_KEY = 'REPLACE_WITH_A_RANDOM_SHARED_SECRET';

function doGet(e) {
  var key = e && e.parameter && e.parameter.key;
  if (key !== REFRESH_KEY) {
    return ContentService.createTextOutput('Forbidden').setMimeType(ContentService.MimeType.TEXT);
  }
  var count = refreshLiveOrders();
  return ContentService.createTextOutput('OK, refreshed ' + count + ' data source(s)').setMimeType(ContentService.MimeType.TEXT);
}

/** Re-runs every Connected Sheet data source in this spreadsheet. Returns how many were refreshed. */
function refreshLiveOrders() {
  var sources = SpreadsheetApp.getActiveSpreadsheet().getDataSources();
  sources.forEach(function (ds) { ds.refreshData(); });
  return sources.length;
}
