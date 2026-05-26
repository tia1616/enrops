// Enrops Roster Sync — Google Apps Script
// ---------------------------------------------------------------------------
// Reads each per-camp sheet in the tenant's Squarespace-export Drive folder
// and pushes the rows to the apps-script-roster-sync edge function on
// Supabase. The edge function matches each sheet to a camp_session by
// filename pattern and upserts parents + students + registrations.
//
// SETUP (one-time, per tenant):
//
//   1. Open https://script.google.com → "New project"
//      (rename to "Enrops Roster Sync" for clarity)
//
//   2. Paste this entire file as Code.gs (replace the default content)
//
//   3. Project Settings (gear icon, left sidebar) → "Script Properties" →
//      "Edit script properties" → Add property:
//           Property: ROSTER_SYNC_SECRET
//           Value:    (paste the secret from your Enrops admin — Jessica
//                      has it for J2S)
//      Click "Save script properties".
//
//   4. Update FOLDER_ID below to the Drive folder that holds your per-camp
//      Squarespace exports. (For J2S it's already set.)
//
//   5. Triggers (clock icon, left sidebar) → "Add Trigger":
//           Function:      syncAllRosters
//           Event source:  Time-driven
//           Type:          Week timer
//           Day:           Sunday
//           Time:          11pm to midnight
//      Save. Google will ask you to authorize the script the first time.
//
//   6. Click "Run" on syncAllRosters manually once to authorize and verify
//      it works. The View → Logs panel shows per-sheet results.
//
//   7. OPTIONAL faster sync: install a second trigger
//           Function:      onAllOrdersChange
//           Event source:  From spreadsheet
//           Spreadsheet:   pick "All Orders" (the master sheet in your
//                          Drive folder)
//           Event type:    On change
//      This fires whenever any row anywhere in "All Orders" changes (i.e.
//      a new registration lands or a refund posts).
//
// MAINTENANCE:
//   - If Squarespace renames a column, update column references in the
//     edge function (apps-script-roster-sync) NOT this script — this
//     script just passes raw rows through.
//   - If you need to rotate the secret, generate a new one in Enrops,
//     update the ROSTER_SYNC_SECRET property here, run syncAllRosters
//     once to verify.

const SUPABASE_URL = 'https://iuasfpztkmrtagivlhtj.supabase.co';
const FUNCTION_PATH = '/functions/v1/apps-script-roster-sync';

// J2S Squarespace export folder. Change per tenant.
const FOLDER_ID = '1AtX5bmG6Cuhjem0ssiA7VUr0YmvEIFmg';

// --- Main entry points ---

function syncAllRosters() {
  const secret = getSecret();
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const files = folder.getFiles();
  const summary = [];

  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();

    // Skip the All Orders master + anything that isn't a per-camp sheet.
    if (name === 'All Orders') continue;
    if (file.getMimeType() !== MimeType.GOOGLE_SHEETS) continue;
    if (!/Summer Camp:/i.test(name)) continue;

    try {
      const result = syncSheet(file, secret);
      summary.push({ name: name, result: result });
    } catch (e) {
      summary.push({ name: name, error: String(e) });
      console.warn('sync failed for ' + name + ': ' + e);
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

// Bound to "All Orders" via an On-change trigger. Throttled so a flurry
// of edits doesn't fire many syncs back-to-back.
function onAllOrdersChange() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    Utilities.sleep(2000);
    syncAllRosters();
  } finally {
    lock.releaseLock();
  }
}

// --- Helpers ---

function getSecret() {
  const s = PropertiesService.getScriptProperties().getProperty('ROSTER_SYNC_SECRET');
  if (!s) {
    throw new Error('ROSTER_SYNC_SECRET not set. Project Settings → Script Properties.');
  }
  return s;
}

function syncSheet(file, secret) {
  const ss = SpreadsheetApp.openById(file.getId());
  const sheet = ss.getSheets()[0];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { skipped: 'empty' };

  const headers = data[0].map(function (h) { return String(h); });
  const rows = data.slice(1)
    .filter(function (row) { return row.some(function (c) { return c !== ''; }); })
    .map(function (row) {
      const obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    });

  if (rows.length === 0) return { skipped: 'no_rows' };

  const payload = {
    secret: secret,
    camp_filename: file.getName(),
    rows: rows,
  };

  const resp = UrlFetchApp.fetch(SUPABASE_URL + FUNCTION_PATH, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  const body = resp.getContentText();
  if (code >= 400) {
    throw new Error('HTTP ' + code + ': ' + body);
  }
  return JSON.parse(body);
}
