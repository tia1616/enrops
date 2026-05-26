// Enrops Roster Sync — Google Apps Script
// ---------------------------------------------------------------------------
// Reads each per-camp sheet in the tenant's Squarespace-export Drive folder
// and pushes the rows to the apps-script-roster-sync edge function on
// Supabase. The edge function matches each sheet to a camp_session by
// filename pattern and upserts parents + students + registrations.
//
// SCRIPT PROPERTIES (Project Settings → Script properties):
//   ROSTER_SYNC_SECRET   (required) — tenant secret from Enrops
//   IGNORE_FILENAMES     (optional) — JSON array of filenames to skip
//                                     entirely, e.g. cancelled camps whose
//                                     Drive sheet you want to keep for
//                                     refund tracking but don't want to
//                                     warn about every sync. Example:
//                                     ["7/13-7/17 Morning - West Linn Summer Camp: LEGO Superheroes"]
//                                     Whitespace is normalized before
//                                     comparison so extra spaces in the
//                                     real filename are tolerated.

const SUPABASE_URL = 'https://iuasfpztkmrtagivlhtj.supabase.co';
const FUNCTION_PATH = '/functions/v1/apps-script-roster-sync';

// J2S Squarespace export folder. Change per tenant.
const FOLDER_ID = '1AtX5bmG6Cuhjem0ssiA7VUr0YmvEIFmg';

function syncAllRosters() {
  const secret = getSecret();
  const ignore = getIgnoreList();
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const files = folder.getFiles();
  const summary = [];

  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();

    if (name === 'All Orders') continue;
    if (file.getMimeType() !== MimeType.GOOGLE_SHEETS) continue;
    if (!/Summer Camp:/i.test(name)) continue;
    if (ignore.indexOf(normalizeName(name)) !== -1) {
      summary.push({ name: name, skipped: 'ignored_by_config' });
      continue;
    }

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

function getSecret() {
  const s = PropertiesService.getScriptProperties().getProperty('ROSTER_SYNC_SECRET');
  if (!s) {
    throw new Error('ROSTER_SYNC_SECRET not set. Project Settings → Script Properties.');
  }
  return s;
}

function getIgnoreList() {
  const raw = PropertiesService.getScriptProperties().getProperty('IGNORE_FILENAMES');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(function (n) { return normalizeName(String(n)); });
  } catch (e) {
    console.warn('IGNORE_FILENAMES not valid JSON; ignoring. Value: ' + raw);
    return [];
  }
}

function normalizeName(s) {
  return String(s).replace(/\s+/g, ' ').trim();
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
