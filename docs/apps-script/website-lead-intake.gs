// Enrops Website Lead Intake — Google Apps Script
// ---------------------------------------------------------------------------
// Bound to the "J2S Get Notified Submissions" sheet. Every five minutes it
// finds the rows that have not been synced yet, POSTs them to the Enrops
// `website-lead-intake` edge function, and writes the timestamp back.
//
// WHY A TIMER AND NOT onFormSubmit: Squarespace APPENDS rows to the sheet
// through the Sheets API. onFormSubmit only fires for Google Forms, so it
// would never run. A time-driven trigger is the only thing that sees these
// rows.
//
// WHAT IT NEVER DOES: touch Squarespace's own columns. It does not edit,
// reorder, insert or rename any of them. The only cell it writes is
// `synced_at`, a column this script adds at the FAR RIGHT of the sheet,
// past whatever Squarespace has.
//
// RETRY: a row is stamped only when Enrops reports it handled — created,
// merged, unchanged, or deliberately skipped (a test row, a bad address, an
// unsubscribed address). Anything else leaves the cell empty and the row is
// tried again on the next run.
//
// ---------------------------------------------------------------------------
// INSTALL (once, ~5 minutes)
//
//  1. Open the sheet "J2S Get Notified Submissions".
//  2. Extensions -> Apps Script. A new project opens.
//  3. Delete whatever is in Code.gs and paste this whole file in. Save.
//  4. Project Settings (the gear on the left) -> Script properties ->
//     "Add script property":
//        name : ENROPS_SECRET
//        value: (the secret Enrops gives you - it is the J2S row's
//                organizations.apps_script_sync_secret)
//     Save script properties. The secret lives ONLY here, never in the code.
//
//     Optional second property, only for testing against staging:
//        name : ENROPS_BASE_URL
//        value: https://mumfymlapolsfdnpewci.supabase.co
//     Leave it unset and the script talks to production.
//
//  5. Back in the editor, pick the function `syncNewLeads` from the dropdown
//     at the top and press Run. Google asks for permission the first time
//     (it needs to read and write this spreadsheet, and to call an external
//     URL) - approve it. Check the execution log: it prints a summary.
//  6. Triggers (the alarm-clock icon on the left) -> "Add Trigger":
//        Choose which function to run          : syncNewLeads
//        Choose which deployment should run    : Head
//        Select event source                   : Time-driven
//        Select type of time based trigger     : Minutes timer
//        Select minute interval                : Every 5 minutes
//        Failure notification settings         : Notify me immediately
//     Save.
//
// That is the whole install. New submissions appear in Enrops Contacts
// within five minutes, tagged `website-notify` plus one tag per interest.
// ---------------------------------------------------------------------------

// Production Enrops. Overridden by the ENROPS_BASE_URL script property when
// one is set (used to point a copy of this script at staging).
var DEFAULT_BASE_URL = 'https://iuasfpztkmrtagivlhtj.supabase.co';
var FUNCTION_PATH = '/functions/v1/website-lead-intake';

// The column this script owns. Added at the far right if it is not there yet.
var SYNCED_HEADER = 'synced_at';

// One request per run. A larger backlog drains over consecutive runs.
var BATCH_LIMIT = 200;

function syncNewLeads() {
  // A run that overlaps the previous one would POST the same rows twice. The
  // edge function is idempotent, so that is safe rather than harmful, but the
  // lock keeps the log readable.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log('another run is in progress; skipping this tick');
    return;
  }
  try {
    return runSync_();
  } finally {
    lock.releaseLock();
  }
}

function runSync_() {
  var secret = getSecret_();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    console.log('no data rows yet');
    return { sent: 0 };
  }

  var syncedCol = ensureSyncedColumn_(sheet);
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // Read displayed values, not raw ones: a date cell comes back as the text
  // the operator sees rather than a Date object that JSON would mangle into
  // a timezone-shifted string.
  var body = sheet.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();

  var pending = [];
  for (var i = 0; i < body.length; i++) {
    var rowNumber = i + 2;
    var cells = body[i];
    if (String(cells[syncedCol - 1] || '').trim() !== '') continue;  // already synced
    if (isBlankRow_(cells)) continue;

    var values = {};
    for (var c = 0; c < headers.length; c++) {
      var h = String(headers[c] || '').trim();
      if (!h) continue;
      values[h] = cells[c];
    }
    pending.push({ row_number: rowNumber, values: values });
    if (pending.length >= BATCH_LIMIT) break;
  }

  if (pending.length === 0) {
    console.log('nothing new to sync');
    return { sent: 0 };
  }

  var result = post_(secret, pending);
  var stamped = stampSynced_(sheet, syncedCol, result);

  // `rows` counts SHEET ROWS, `contacts` counts PEOPLE. Two rows from the same
  // family are one contact, so the two numbers differ on purpose.
  var rows = result.rows || {};
  var contacts = result.contacts || {};
  console.log(JSON.stringify({
    rows_sent: pending.length,
    rows_stamped: stamped,
    contacts_created: contacts.created,
    contacts_merged: contacts.merged,
    contacts_unchanged: contacts.unchanged,
    rows_skipped_test: rows.skipped_test,
    rows_skipped_suppressed: rows.skipped_suppressed,
    rows_skipped_invalid_email: rows.skipped_invalid_email,
    rows_failed: rows.failed,
    unmapped_interests: result.unmapped_interests
  }, null, 2));

  // Surface a real failure rather than logging it quietly - the trigger's
  // "notify me immediately" setting only fires on a thrown error.
  if (rows.failed > 0) {
    throw new Error(rows.failed + ' row(s) failed in Enrops and will be retried next run. See the results above.');
  }
  return result;
}

// --- helpers ---------------------------------------------------------------

function getSecret_() {
  var s = PropertiesService.getScriptProperties().getProperty('ENROPS_SECRET');
  if (!s) {
    throw new Error('ENROPS_SECRET not set. Project Settings -> Script properties.');
  }
  return s;
}

function getBaseUrl_() {
  var u = PropertiesService.getScriptProperties().getProperty('ENROPS_BASE_URL');
  return (u && u.trim()) ? u.trim().replace(/\/+$/, '') : DEFAULT_BASE_URL;
}

// Finds the synced_at column, appending it at the FAR RIGHT if it is missing.
// Never inserts, moves or renames one of Squarespace's columns.
function ensureSyncedColumn_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  for (var c = 0; c < headers.length; c++) {
    if (String(headers[c] || '').trim().toLowerCase() === SYNCED_HEADER) return c + 1;
  }
  var col = lastCol + 1;
  sheet.getRange(1, col).setValue(SYNCED_HEADER);
  // Flush before returning: the caller re-reads getLastColumn() immediately and
  // an unflushed write would leave it one column short, so the values read
  // below would not include this column at all.
  SpreadsheetApp.flush();
  return col;
}

function isBlankRow_(cells) {
  for (var i = 0; i < cells.length; i++) {
    if (String(cells[i] || '').trim() !== '') return false;
  }
  return true;
}

function post_(secret, rows) {
  var resp = UrlFetchApp.fetch(getBaseUrl_() + FUNCTION_PATH, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-enrops-secret': secret },
    payload: JSON.stringify({ rows: rows }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code === 401) {
    throw new Error('Enrops rejected the secret (401). Check the ENROPS_SECRET script property.');
  }
  if (code >= 400) {
    throw new Error('Enrops returned HTTP ' + code + ': ' + text);
  }
  return JSON.parse(text);
}

// Stamps synced_at for every row Enrops reports as handled. A row that errored
// is left alone so the next run picks it up again.
var HANDLED = {
  created: true,
  merged: true,
  unchanged: true,
  skipped_test: true,
  skipped_suppressed: true,
  skipped_invalid_email: true
};

function stampSynced_(sheet, syncedCol, result) {
  var stamp = new Date().toISOString();
  var results = result && result.results ? result.results : [];
  var stamped = 0;
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (!HANDLED[r.status]) continue;
    var rowNumber = Number(r.row_number);
    if (!rowNumber || rowNumber < 2) continue;
    sheet.getRange(rowNumber, syncedCol).setValue(stamp);
    stamped++;
  }
  // Force the writes out before the run ends.
  SpreadsheetApp.flush();
  return stamped;
}
