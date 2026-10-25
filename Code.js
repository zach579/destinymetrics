/**
 * CampusMetrics automated input
 * =============================
 * Lives inside the Usher Form spreadsheet. Three jobs:
 *   1. syncUsherForm — pushes usher form submissions into CampusMetrics
 *      (adults, salvations, baptisms — volunteers come from PCO scheduling)
 *   2. syncPCOKids  — pulls kids check-in counts from Planning Center
 *      and writes them as the "kids" metric
 *   3. syncPCOScheduledVolunteers — counts unique, non-declined people
 *      for each service time across every team in each campus folder
 *      (also mirrors a per-team breakdown into the volunteer_teams table)
 *   4. syncGrowthTrackStep3Forms — when a Growth Track person first has all
 *      3 steps + a mappable team preference, POST Church Center form 551600
 *      so team onboarding workflows fire (see GT_STEP3_* section)
 *
 * SETUP:
 * 1. In Supabase → Authentication → Add user:
 *      automation@destinychurchtn.com + a strong password (Auto Confirm).
 *    Then tell Claude / your admin to assign it ALL campuses
 *    (or in the app: Setup & Data → Team access → check all three).
 * 2. In this spreadsheet: Extensions → Apps Script → paste this file.
 * 3. Project Settings → Script Properties, add:
 *      SB_EMAIL     = automation user email
 *      SB_PASSWORD  = automation user password
 *      PCO_APP_ID   = from api.planningcenteronline.com → Personal Access Token
 *      PCO_SECRET   = the token's secret
 *      REPORT_RECIPIENTS = comma-separated email addresses for weekly reports
 *      ALERT_RECIPIENTS  = optional comma-separated addresses for form alerts
 *                          (falls back to REPORT_RECIPIENTS when omitted)
 * 4. Run listPCOEvents() once, open the log (View → Logs), and fill in
 *    PCO_EVENT_MAP below with the event-time IDs it prints.
 * 5. Triggers:
 *      syncUsherForm → From spreadsheet → On form submit
 *      syncPCOKids   → Time-driven → Every hour  (it only acts on Sundays 11am–8pm)
 *      Run installEmailReportTriggers() once to create the Sunday 1pm
 *      scheduled-volunteer sync, Sunday 2pm missing-entry check and report,
 *      and Thursday 8am report in the script's configured time zone.
 * 6. Run backfillPCOScheduledVolunteers() once to populate one year of
 *    volunteer history. It continues automatically in small batches.
 * 7. Run backfillPCOYouth() once to populate one year of Wednesday youth
 *    attendance. It also continues automatically in small batches.
 */

/* ================= CONFIG ================= */

const SUPABASE_URL = 'https://ujzmknckieektcdbpyvr.supabase.co';
const ANON_KEY     = 'sb_publishable_0It-cjntEVG4TmR-dSLYIg_PynHuO_8';

// form's "What Service" answer → service label per campus
const SERVICE_MAP = {
  'Columbia':    { 'First Service':'8:30 AM', 'Second Service':'10:00 AM', 'Third Service':'11:30 AM' },
  'Lewisburg':   { 'First Service':'8:30 AM', 'Second Service':'10:00 AM', 'Third Service':'11:30 AM' },
  'Shelbyville': { 'First Service':'10:00 AM' }
};

// PCO events → where the check-in count goes.
// Run listPCOEvents() and copy the event IDs it prints, one line per campus/service.
//   day:    0 = Sunday, 3 = Wednesday
//   metric: 'kids' for Sunday kids check-ins, 'adults' for youth headcount
// Examples (replace eventId with real IDs from listPCOEvents):
const PCO_EVENT_MAP = [
  // Sunday kids check-ins
  { eventId: '1027835', startsAt: '08:30', day: 0, campus: 'Columbia',    service: '8:30 AM',     metric: 'kids' },
  { eventId: '1027835', startsAt: '10:00', day: 0, campus: 'Columbia',    service: '10:00 AM',    metric: 'kids' },
  { eventId: '1027835', startsAt: '11:30', day: 0, campus: 'Columbia',    service: '11:30 AM',    metric: 'kids' },
  { eventId: '605454', startsAt: '08:30', day: 0, campus: 'Lewisburg',   service: '8:30 AM',     metric: 'kids' },
  { eventId: '605454', startsAt: '10:00', day: 0, campus: 'Lewisburg',   service: '10:00 AM',    metric: 'kids' },
  { eventId: '605454', startsAt: '11:30', day: 0, campus: 'Lewisburg',   service: '11:30 AM',    metric: 'kids' },
  { eventId: '898304', startsAt: '10:00', day: 0, campus: 'Shelbyville', service: '10:00 AM',    metric: 'kids' },
  // Wednesday youth check-ins (counts land on the Youth (Wed) row)
  { eventId: '473277', startsAt: '17:00', day: 3, campus: 'Columbia',    service: 'Youth (Wed)', metric: 'adults' },
  { eventId: '770290', startsAt: '17:30', day: 3, campus: 'Lewisburg',   service: 'Youth (Wed)', metric: 'adults' },
  { eventId: '952544', startsAt: '17:00', day: 3, campus: 'Shelbyville', service: 'Youth (Wed)', metric: 'adults' },
];

// Planning Center Services folder names. Change the values only if the folder
// names in Planning Center do not exactly match the CampusMetrics campus names.
const PCO_SERVICES_FOLDER_NAMES = {
  'Columbia':    'SUNDAY (COL)',
  'Lewisburg':   'SUNDAY (LWB)',
  'Shelbyville': 'SUNDAY (SVL)'
};

const FORM_SHEET   = 'Form Responses 1';
const WEEKS_BACK   = 6;   // how far back the form sync looks
const VOLUNTEER_HISTORY_WEEKS = 52;
const VOLUNTEER_BACKFILL_BATCH_WEEKS = 4;
const VOLUNTEER_BACKFILL_HANDLER = 'continuePCOVolunteerHistoryBackfill';
const VOLUNTEER_BACKFILL_NEXT_PROPERTY = 'PCO_VOLUNTEER_BACKFILL_NEXT_WEEK';
const VOLUNTEER_BACKFILL_TOTAL_PROPERTY = 'PCO_VOLUNTEER_BACKFILL_TOTAL_WEEKS';
const YOUTH_HISTORY_WEEKS = 52;
const YOUTH_BACKFILL_BATCH_WEEKS = 8;
const YOUTH_BACKFILL_HANDLER = 'continuePCOYouthHistoryBackfill';
const YOUTH_BACKFILL_NEXT_PROPERTY = 'PCO_YOUTH_BACKFILL_NEXT_WEEK';
const YOUTH_BACKFILL_TOTAL_PROPERTY = 'PCO_YOUTH_BACKFILL_TOTAL_WEEKS';
const REPORT_RECIPIENTS_PROPERTY = 'REPORT_RECIPIENTS';
const ALERT_RECIPIENTS_PROPERTY = 'ALERT_RECIPIENTS';
// Always added to the weekly Sunday/Thursday reports, on top of REPORT_RECIPIENTS.
const EXTRA_REPORT_RECIPIENTS = ['steven.m@destinychurchtn.com', 'jonathan@destinychurchtn.com'];

function reportRecipients_() {
  var raw = PropertiesService.getScriptProperties().getProperty(REPORT_RECIPIENTS_PROPERTY) || '';
  var seen = {}, out = [];
  raw.split(',').concat(EXTRA_REPORT_RECIPIENTS).forEach(function(e) {
    e = String(e).trim();
    if (e && !seen[e.toLowerCase()]) { seen[e.toLowerCase()] = true; out.push(e); }
  });
  return out.join(',');
}
const FORM_STATUS_HEADER = 'CampusMetrics Status';
const SUNDAY_REPORT_HOUR = 14;    // 2pm
const THURSDAY_REPORT_HOUR = 8;   // 8am

/* ================= USHER FORM → SUPABASE ================= */

function syncUsherForm() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    syncUsherForm_();
  } finally {
    lock.releaseLock();
  }
}

function syncUsherForm_() {
  const token = sbSignIn_();
  const services = sbServices_(token);          // "Campus|Label" -> service_id
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FORM_SHEET);
  if (!sheet) throw new Error('Usher form sheet not found: ' + FORM_SHEET);
  const data = sheet.getDataRange().getValues();
  if (!data.length) return;
  const head = data[0].map(h => String(h).toLowerCase().trim());
  const col = name => head.findIndex(h => h.indexOf(name) !== -1);
  const iTime = col('timestamp'), iCampus = col('campus'), iSvc = col('service'),
        iAtt  = col('attendance'), iSalv = col('salvation'),
        iBapt = col('baptism');
  if ([iTime, iCampus, iSvc].some(function(i) { return i < 0; })) {
    throw new Error('The usher form needs Timestamp, Campus, and Service columns.');
  }

  var iStatus = head.indexOf(FORM_STATUS_HEADER.toLowerCase());
  if (iStatus < 0) {
    iStatus = data[0].length;
    sheet.getRange(1, iStatus + 1).setValue(FORM_STATUS_HEADER).setFontWeight('bold');
    data.forEach(function(row) { while (row.length <= iStatus) row.push(''); });
  }

  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7 * WEEKS_BACK);
  const accepted = {}; // week|service_id -> first valid row payload
  const statusValues = data.slice(1).map(function(row) { return [row[iStatus] || '']; });
  const duplicateAlerts = [];

  for (let r = 1; r < data.length; r++) {
    const ts = new Date(data[r][iTime]);
    if (isNaN(ts) || ts < cutoff) continue;
    const campus = String(data[r][iCampus]).trim();
    const svcAnswer = String(data[r][iSvc]).trim();
    const label = SERVICE_MAP[campus] && SERVICE_MAP[campus][svcAnswer];
    if (!label) continue;
    const sid = services[campus + '|' + label];
    if (!sid) continue;
    const week = sundayISO_(ts);
    const key = week + '|' + sid;
    if (accepted[key]) {
      var heldStatus = 'HELD — duplicate of row ' + accepted[key].rowNumber;
      var oldStatus = String(data[r][iStatus] || '');
      if (oldStatus.indexOf('alert sent') === -1) {
        duplicateAlerts.push({
          rowNumber: r + 1,
          firstRowNumber: accepted[key].rowNumber,
          timestamp: ts,
          campus: campus,
          service: label,
          week: week
        });
        heldStatus += ' — alert pending';
      } else {
        heldStatus += ' — alert sent';
      }
      statusValues[r - 1][0] = heldStatus;
      continue;
    }
    const p = { week: week, service_id: sid };
    setNum_(p, 'adults',     data[r][iAtt]);
    setNum_(p, 'salvations', data[r][iSalv]);
    setNum_(p, 'baptisms',   data[r][iBapt]);
    accepted[key] = {payload: p, rowNumber: r + 1};
    statusValues[r - 1][0] = 'SYNCED — first entry used';
  }

  if (statusValues.length) {
    sheet.getRange(2, iStatus + 1, statusValues.length, 1).setValues(statusValues);
  }
  const rows = Object.keys(accepted).map(function(key) { return accepted[key].payload; });
  if (rows.length) sbUpsert_(rows, token);
  if (duplicateAlerts.length) sendDuplicateUsherAlert_(sheet, duplicateAlerts, iStatus);
  Logger.log('Usher form: synced ' + rows.length + ' campus/service rows');
}

function sendDuplicateUsherAlert_(sheet, duplicates, statusColumn) {
  var recipients = alertRecipients_();
  var timeZone = Session.getScriptTimeZone();
  var lines = duplicates.map(function(item) {
    return item.campus + ' · ' + item.service + ' · week of ' + item.week +
      '\n  First entry: row ' + item.firstRowNumber +
      '\n  Held duplicate: row ' + item.rowNumber + ' (' +
      Utilities.formatDate(item.timestamp, timeZone, 'MMM d, yyyy h:mm a') + ')';
  });
  var subject = 'CampusMetrics duplicate usher ' +
    (duplicates.length === 1 ? 'entry held' : 'entries held');
  var body = 'A duplicate usher form submission was held and was not sent to CampusMetrics.\n' +
    'The first submission remains authoritative. Review the rows below before making any manual correction.\n\n' +
    lines.join('\n\n') + '\n\nUsher form responses: ' + sheet.getParent().getUrl();

  MailApp.sendEmail({
    to: recipients,
    subject: subject,
    body: body,
    name: 'CampusMetrics'
  });
  duplicates.forEach(function(item) {
    sheet.getRange(item.rowNumber, statusColumn + 1)
      .setValue('HELD — duplicate of row ' + item.firstRowNumber + ' — alert sent');
  });
  Logger.log(subject + ' notification sent to ' + recipients);
}

/** Sunday 2pm safeguard: notify only when a configured usher entry is missing. */
function sendMissingUsherEntryAlert() {
  var now = new Date();
  var week = sundayISO_(now);
  var propertyKey = 'MISSING_USHER_ALERT_SENT_' + week;
  var properties = PropertiesService.getScriptProperties();
  if (properties.getProperty(propertyKey)) {
    Logger.log('Missing-entry alert already sent for ' + week);
    return;
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FORM_SHEET);
  if (!sheet) throw new Error('Usher form sheet not found: ' + FORM_SHEET);
  var data = sheet.getDataRange().getValues();
  if (!data.length) throw new Error('Usher form sheet is empty.');
  var head = data[0].map(function(h) { return String(h).toLowerCase().trim(); });
  var col = function(name) { return head.findIndex(function(h) { return h.indexOf(name) !== -1; }); };
  var iTime = col('timestamp'), iCampus = col('campus'), iSvc = col('service');
  if ([iTime, iCampus, iSvc].some(function(i) { return i < 0; })) {
    throw new Error('The usher form needs Timestamp, Campus, and Service columns.');
  }

  var submitted = {};
  for (var r = 1; r < data.length; r++) {
    var timestamp = new Date(data[r][iTime]);
    if (isNaN(timestamp) || sundayISO_(timestamp) !== week) continue;
    var campus = String(data[r][iCampus]).trim();
    var answer = String(data[r][iSvc]).trim();
    var label = SERVICE_MAP[campus] && SERVICE_MAP[campus][answer];
    if (label) submitted[campus + '|' + label] = true;
  }

  var expected = [];
  Object.keys(SERVICE_MAP).forEach(function(campus) {
    Object.keys(SERVICE_MAP[campus]).forEach(function(answer) {
      var label = SERVICE_MAP[campus][answer];
      if (!expected.some(function(item) { return item.campus === campus && item.service === label; })) {
        expected.push({campus: campus, service: label});
      }
    });
  });
  var missing = expected.filter(function(item) {
    return !submitted[item.campus + '|' + item.service];
  });
  if (!missing.length) {
    Logger.log('All configured usher entries are present for ' + week);
    return;
  }

  var recipients = alertRecipients_();
  var missingLines = missing.map(function(item) { return '• ' + item.campus + ' · ' + item.service; });
  var subject = 'CampusMetrics missing usher entries — ' + reportDateLabel_(week);
  var formUrl = sheet.getParent().getFormUrl() || sheet.getParent().getUrl();
  var body = 'As of the Sunday 2 PM check, these usher form entries are missing:\n\n' +
    missingLines.join('\n') + '\n\nPlease submit the missing counts here: ' + formUrl +
    '\n\nUsher form responses: ' + sheet.getParent().getUrl();
  MailApp.sendEmail({to: recipients, subject: subject, body: body, name: 'CampusMetrics'});
  properties.setProperty(propertyKey, new Date().toISOString());
  Logger.log(subject + ' sent to ' + recipients);
}

function alertRecipients_() {
  var properties = PropertiesService.getScriptProperties();
  var recipients = properties.getProperty(ALERT_RECIPIENTS_PROPERTY) ||
    properties.getProperty(REPORT_RECIPIENTS_PROPERTY);
  if (!recipients || !recipients.trim()) {
    throw new Error('Missing Script Property ' + ALERT_RECIPIENTS_PROPERTY +
      ' (or fallback ' + REPORT_RECIPIENTS_PROPERTY + ').');
  }
  return recipients.trim();
}

/* ================= PCO CHECK-INS → SUPABASE (kids) ================= */

function syncPCOKids() {
  const now = new Date();
  if (now.getHours() < 9 || now.getHours() > 22) return;          // active hours only
  const due = PCO_EVENT_MAP.filter(function(m){ return m.day === now.getDay(); });
  if (due.length) syncPCONow_(due);
}

/** Run manually to force a sync of every mapping for its most recent event day. */
function syncPCONow() { syncPCONow_(PCO_EVENT_MAP); }

function syncPCONow_(maps) {
  if (!maps.length) { Logger.log('PCO_EVENT_MAP is empty — run listPCOEvents() and fill it in.'); return; }
  const token = sbSignIn_();
  const services = sbServices_(token);
  const rows = [];

  maps.forEach(function(m) {
    const sid = services[m.campus + '|' + m.service];
    if (!sid) { Logger.log('No service in app for ' + m.campus + ' ' + m.service); return; }
    // Prefer the configured start time. If this mapping is the only one for
    // its event/day, fall back to the most recent time that day so seasonal
    // schedule changes keep syncing.
    const times = pcoCurrentEventTimes_(m.eventId);
    const candidates = times.filter(function(t) {
      const starts = new Date(t.attributes.starts_at);
      return starts <= new Date() && starts.getDay() === m.day;
    });
    let et = candidates.find(function(t) {
      return hhmm_(new Date(t.attributes.starts_at)) === m.startsAt;
    });
    if (!et && soloMapping_(m)) {
      et = candidates.sort(function(a, b) {
        return new Date(b.attributes.starts_at) - new Date(a.attributes.starts_at);
      })[0];
      if (et) Logger.log('Fallback time ' + hhmm_(new Date(et.attributes.starts_at)) +
        ' used for ' + m.campus + ' ' + m.service + ' (configured ' + m.startsAt + ')');
    }
    if (!et) { Logger.log('No PCO event time found for ' + m.campus + ' ' + m.service); return; }
    const count = pcoCheckInCount_(et.id, 'attendee');
    const row = { week: sundayISO_(new Date(et.attributes.starts_at)), service_id: sid };
    row[m.metric || 'kids'] = count;
    if (m.day === 3) row.volunteers = pcoCheckInCount_(et.id, 'volunteer');
    rows.push(row);
  });

  if (rows.length) sbUpsert_(rows, token);
  Logger.log('PCO sync: ' + JSON.stringify(rows));
}

/** Run manually once to restore one year of Wednesday youth attendance. */
function backfillPCOYouth() {
  var properties = PropertiesService.getScriptProperties();
  properties.setProperty(YOUTH_BACKFILL_NEXT_PROPERTY, '0');
  properties.setProperty(YOUTH_BACKFILL_TOTAL_PROPERTY, String(YOUTH_HISTORY_WEEKS));
  removeYouthBackfillTriggers_();
  continuePCOYouthHistoryBackfill();
}

function continuePCOYouthHistoryBackfill() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    continuePCOYouthHistoryBackfill_();
  } finally {
    lock.releaseLock();
  }
}

function continuePCOYouthHistoryBackfill_() {
  var properties = PropertiesService.getScriptProperties();
  var nextWeek = Number(properties.getProperty(YOUTH_BACKFILL_NEXT_PROPERTY) || 0);
  var totalWeeks = Number(properties.getProperty(YOUTH_BACKFILL_TOTAL_PROPERTY) ||
    YOUTH_HISTORY_WEEKS);
  if (nextWeek >= totalWeeks) {
    finishYouthBackfill_();
    return;
  }

  var batchWeeks = Math.min(YOUTH_BACKFILL_BATCH_WEEKS, totalWeeks - nextWeek);
  syncPCOYouthHistory_(batchWeeks, nextWeek);
  nextWeek += batchWeeks;
  properties.setProperty(YOUTH_BACKFILL_NEXT_PROPERTY, String(nextWeek));

  removeYouthBackfillTriggers_();
  if (nextWeek < totalWeeks) {
    ScriptApp.newTrigger(YOUTH_BACKFILL_HANDLER).timeBased().after(60 * 1000).create();
    Logger.log('Youth history backfill: ' + nextWeek + ' of ' + totalWeeks +
      ' weeks complete; next batch scheduled.');
  } else {
    finishYouthBackfill_();
  }
}

function finishYouthBackfill_() {
  var properties = PropertiesService.getScriptProperties();
  properties.deleteProperty(YOUTH_BACKFILL_NEXT_PROPERTY);
  properties.deleteProperty(YOUTH_BACKFILL_TOTAL_PROPERTY);
  removeYouthBackfillTriggers_();
  Logger.log('Youth history backfill complete.');
}

function removeYouthBackfillTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === YOUTH_BACKFILL_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function syncPCOYouthHistory_(weekCount, offsetWeeks) {
  var maps = PCO_EVENT_MAP.filter(function(m) { return m.day === 3; });
  if (!maps.length) throw new Error('No Wednesday youth mappings are configured in PCO_EVENT_MAP.');
  var token = sbSignIn_();
  var services = sbServices_(token);
  var newestWeekDate = new Date(sundayISO_(new Date()) + 'T12:00:00');
  newestWeekDate.setDate(newestWeekDate.getDate() - (Number(offsetWeeks || 0) * 7));
  var newestWeek = sundayISO_(newestWeekDate);
  var oldestWeekDate = new Date(newestWeek + 'T12:00:00');
  oldestWeekDate.setDate(oldestWeekDate.getDate() - ((weekCount - 1) * 7));
  var rangeStart = new Date(sundayISO_(oldestWeekDate) + 'T00:00:00');
  var rangeEnd = new Date(newestWeek + 'T00:00:00');
  rangeEnd.setDate(rangeEnd.getDate() + 7);
  var rowByKey = {};

  maps.forEach(function(m) {
    var sid = services[m.campus + '|' + m.service];
    if (!sid) {
      throw new Error('CampusMetrics service missing: ' + m.campus + ' ' + m.service +
        '. Add that exact service in Setup & Data, then run this function again.');
    }
    var flexible = soloMapping_(m);
    pcoHistoricalEventTimes_(m.eventId).filter(function(eventTime) {
      var starts = new Date(eventTime.attributes.starts_at);
      return !isNaN(starts) && starts <= new Date() &&
        starts >= rangeStart && starts < rangeEnd &&
        starts.getDay() === m.day &&
        (flexible || hhmm_(starts) === m.startsAt);
    }).sort(function(a, b) {
      var aExact = hhmm_(new Date(a.attributes.starts_at)) === m.startsAt ? 0 : 1;
      var bExact = hhmm_(new Date(b.attributes.starts_at)) === m.startsAt ? 0 : 1;
      return (aExact - bExact) ||
        (new Date(b.attributes.starts_at) - new Date(a.attributes.starts_at));
    }).forEach(function(eventTime) {
      var starts = new Date(eventTime.attributes.starts_at);
      var week = sundayISO_(starts);
      var key = week + '|' + sid;
      if (rowByKey[key]) return;
      var row = {week: week, service_id: sid};
      var count = pcoCheckInCount_(eventTime.id, 'attendee');
      row[m.metric || 'adults'] = count;
      row.volunteers = pcoCheckInCount_(eventTime.id, 'volunteer');
      rowByKey[key] = row;
      Logger.log('Youth backfill ' + week + ' ' + m.campus + ': ' +
        row[m.metric || 'adults'] + ' attendees, ' + row.volunteers + ' volunteers');
    });
  });

  var rows = Object.keys(rowByKey).map(function(key) { return rowByKey[key]; });
  if (rows.length) sbUpsert_(rows, token);
  Logger.log('Youth check-in backfill weeks ' + sundayISO_(oldestWeekDate) +
    ' through ' + newestWeek + ': ' + rows.length + ' campus/week rows synced.');
}

/** Return the PCO event-time total for one Check-Ins category. */
function pcoCheckInCount_(eventTimeId, filter) {
  var response = pcoGet_('/check-ins/v2/event_times/' + eventTimeId +
    '/check_ins?filter=' + encodeURIComponent(filter) + '&per_page=1');
  return Number(response.meta && response.meta.total_count || 0);
}

function pcoCurrentEventTimes_(eventId) {
  return pcoGet_('/check-ins/v2/events/' + eventId +
    '/current_event_times?order=-starts_at&per_page=100').data || [];
}

function pcoHistoricalEventTimes_(eventId) {
  var response = pcoGet_('/check-ins/v2/events/' + eventId +
    '/event_periods?include=event_times&order=-starts_at&per_page=100');
  var seen = {};
  var times = (response.included || []).filter(function(item) {
    if (String(item.type).toLowerCase() !== 'eventtime' || seen[item.id]) return false;
    seen[item.id] = true;
    return true;
  });
  Logger.log('Historical event times found for event ' + eventId + ': ' + times.length);
  return times;
}

/** Run this once to discover your PCO events & times, then fill PCO_EVENT_MAP. */
function listPCOEvents() {
  const events = pcoGet_('/check-ins/v2/events?per_page=100').data || [];
  events.forEach(function(ev) {
    Logger.log('EVENT ' + ev.id + '  "' + ev.attributes.name + '"');
    const times = pcoGet_('/check-ins/v2/events/' + ev.id + '/current_event_times?order=-starts_at&per_page=8').data || [];
    times.forEach(function(t) {
      const d = new Date(t.attributes.starts_at);
      Logger.log('   recent time: ' + t.attributes.starts_at + '  (local ' + hhmm_(d) + ')');
    });
  });
  Logger.log('Fill PCO_EVENT_MAP like: { eventId: "<EVENT id>", startsAt: "08:30", campus: "Columbia", service: "8:30 AM" }');
}

/* ================= PCO SERVICES → SCHEDULED VOLUNTEERS ================= */

function syncPCOScheduledVolunteers() {
  syncPCOScheduledVolunteers_(1, 0);
}

/**
 * Run manually once to start a one-year historical backfill. It processes a
 * few Sundays per execution, then schedules the next batch automatically.
 */
function backfillPCOScheduledVolunteers() {
  var properties = PropertiesService.getScriptProperties();
  properties.setProperty(VOLUNTEER_BACKFILL_NEXT_PROPERTY, '0');
  properties.setProperty(VOLUNTEER_BACKFILL_TOTAL_PROPERTY, String(VOLUNTEER_HISTORY_WEEKS));
  removeVolunteerBackfillTriggers_();
  continuePCOVolunteerHistoryBackfill();
}

function continuePCOVolunteerHistoryBackfill() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    continuePCOVolunteerHistoryBackfill_();
  } finally {
    lock.releaseLock();
  }
}

function continuePCOVolunteerHistoryBackfill_() {
  var properties = PropertiesService.getScriptProperties();
  var nextWeek = Number(properties.getProperty(VOLUNTEER_BACKFILL_NEXT_PROPERTY) || 0);
  var totalWeeks = Number(properties.getProperty(VOLUNTEER_BACKFILL_TOTAL_PROPERTY) ||
    VOLUNTEER_HISTORY_WEEKS);
  if (nextWeek >= totalWeeks) {
    finishVolunteerBackfill_();
    return;
  }

  var batchWeeks = Math.min(VOLUNTEER_BACKFILL_BATCH_WEEKS, totalWeeks - nextWeek);
  syncPCOScheduledVolunteers_(batchWeeks, nextWeek);
  nextWeek += batchWeeks;
  properties.setProperty(VOLUNTEER_BACKFILL_NEXT_PROPERTY, String(nextWeek));

  removeVolunteerBackfillTriggers_();
  if (nextWeek < totalWeeks) {
    ScriptApp.newTrigger(VOLUNTEER_BACKFILL_HANDLER).timeBased().after(60 * 1000).create();
    Logger.log('Volunteer history backfill: ' + nextWeek + ' of ' + totalWeeks +
      ' weeks complete; next batch scheduled.');
  } else {
    finishVolunteerBackfill_();
  }
}

function finishVolunteerBackfill_() {
  var properties = PropertiesService.getScriptProperties();
  properties.deleteProperty(VOLUNTEER_BACKFILL_NEXT_PROPERTY);
  properties.deleteProperty(VOLUNTEER_BACKFILL_TOTAL_PROPERTY);
  removeVolunteerBackfillTriggers_();
  Logger.log('Volunteer history backfill complete.');
}

function removeVolunteerBackfillTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === VOLUNTEER_BACKFILL_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function syncPCOScheduledVolunteers_(weekCount, offsetWeeks) {
  var token = sbSignIn_();
  var appServices = sbServices_(token);
  var folders = pcoGetAll_('/services/v2/folders?per_page=100');
  var newestWeekDate = new Date(sundayISO_(new Date()) + 'T12:00:00');
  newestWeekDate.setDate(newestWeekDate.getDate() - (Number(offsetWeeks || 0) * 7));
  var currentWeek = sundayISO_(newestWeekDate);
  var weeks = [];
  for (var w = 0; w < weekCount; w++) {
    var weekDate = new Date(currentWeek + 'T12:00:00');
    weekDate.setDate(weekDate.getDate() - (w * 7));
    weeks.push(sundayISO_(weekDate));
  }
  var weekLookup = {};
  weeks.forEach(function(week) { weekLookup[week] = true; });
  var rangeStart = new Date(weeks[weeks.length - 1] + 'T00:00:00');
  var rangeEnd = new Date(currentWeek + 'T00:00:00');
  rangeEnd.setDate(rangeEnd.getDate() + 7);
  var rows = [];
  var teamRows = [];
  var syncedWeekServices = [];

  Object.keys(PCO_SERVICES_FOLDER_NAMES).forEach(function(campusName) {
    var folderRef = String(PCO_SERVICES_FOLDER_NAMES[campusName]);
    var folder = folders.find(function(f) {
      return String(f.id) === folderRef ||
        String(f.attributes.name || '').toLowerCase() === folderRef.toLowerCase();
    });
    if (!folder) {
      throw new Error('Planning Center Services folder not found for ' + campusName +
        ': "' + folderRef + '". Run listPCOServicesFolders() to see available names and IDs.');
    }

    var serviceTypes = pcoFolderServiceTypes_(folder.id, {});
    var peopleByWeekService = {};
    var peopleByWeekServiceTeam = {};
    var observedWeekServices = {};
    serviceTypes.forEach(function(serviceType) {
      var teamNameById = {};
      pcoGetAll_('/services/v2/service_types/' + serviceType.id + '/teams?per_page=100').forEach(function(team) {
        teamNameById[String(team.id)] = String(team.attributes && team.attributes.name || '').trim() || ('Team ' + team.id);
      });
      var plans = pcoGetAll_('/services/v2/service_types/' + serviceType.id +
        '/plans?order=-sort_date&per_page=100');
      plans.filter(function(plan) {
        var sortDay = String(plan.attributes.sort_date || '').slice(0, 10);
        return sortDay >= weeks[weeks.length - 1] && sortDay <= currentWeek;
      }).forEach(function(plan) {
        var planTimes = pcoGetAll_('/services/v2/service_types/' + serviceType.id +
          '/plans/' + plan.id + '/plan_times?per_page=100');
        var serviceTimeById = {};
        planTimes.forEach(function(planTime) {
          var starts = new Date(planTime.attributes.starts_at);
          if (String(planTime.attributes.time_type || '').toLowerCase() !== 'service' ||
              isNaN(starts) || starts < rangeStart || starts >= rangeEnd) return;
          var serviceWeek = sundayISO_(starts);
          if (!weekLookup[serviceWeek]) return;
          var serviceInfo = {week: serviceWeek, label: pcoServiceLabel_(starts)};
          serviceTimeById[String(planTime.id)] = serviceInfo;
          observedWeekServices[serviceWeek + '|' + serviceInfo.label] = true;
        });

        var members = pcoGetAll_('/services/v2/service_types/' + serviceType.id +
          '/plans/' + plan.id + '/team_members?filter=not_declined&per_page=100');
        members.forEach(function(member) {
          var person = member.relationships && member.relationships.person && member.relationships.person.data;
          var personKey = person && person.id
            ? String(person.id)
            : 'name:' + String(member.attributes.name || member.id).toLowerCase();
          var relationships = member.relationships || {};
          var assignedTimes = relationships.service_times && relationships.service_times.data || [];
          if (!assignedTimes.length) assignedTimes = relationships.times && relationships.times.data || [];
          var assignedIds = assignedTimes.map(function(t) { return String(t.id); })
            .filter(function(id) { return !!serviceTimeById[id]; });
          // Planning Center normally supplies service_times. If a plan-level
          // assignment has none, treat it as scheduled for every service time.
          if (!assignedIds.length) assignedIds = Object.keys(serviceTimeById);
          var teamData = relationships.team && relationships.team.data;
          var teamName = (teamData && teamNameById[String(teamData.id)]) || 'Unassigned';
          assignedIds.forEach(function(timeId) {
            var serviceInfo = serviceTimeById[timeId];
            var weekServiceKey = serviceInfo.week + '|' + serviceInfo.label;
            if (!peopleByWeekService[weekServiceKey]) peopleByWeekService[weekServiceKey] = {};
            peopleByWeekService[weekServiceKey][personKey] = true;
            if (!peopleByWeekServiceTeam[weekServiceKey]) peopleByWeekServiceTeam[weekServiceKey] = {};
            if (!peopleByWeekServiceTeam[weekServiceKey][teamName]) peopleByWeekServiceTeam[weekServiceKey][teamName] = {};
            peopleByWeekServiceTeam[weekServiceKey][teamName][personKey] = true;
          });
        });
      });
    });

    var configured = SERVICE_MAP[campusName] || {};
    var labels = Object.keys(configured).map(function(key) { return configured[key]; })
      .filter(function(label, index, all) { return all.indexOf(label) === index; });
    weeks.forEach(function(week) {
      labels.forEach(function(label) {
        var weekServiceKey = week + '|' + label;
        // Do not overwrite an older value with zero when Planning Center has
        // no historical plan time available for that campus/service.
        if (!observedWeekServices[weekServiceKey]) {
          Logger.log('No Planning Center plan time found; skipped ' + campusName + ' ' + label + ' for ' + week);
          return;
        }
        var serviceId = appServices[campusName + '|' + label];
        if (!serviceId) throw new Error('CampusMetrics service not found for scheduled volunteers: ' + campusName + ' ' + label);
        var count = Object.keys(peopleByWeekService[weekServiceKey] || {}).length;
        rows.push({week: week, service_id: serviceId, volunteers: count});
        syncedWeekServices.push({week: week, service_id: serviceId});
        var teamsForKey = peopleByWeekServiceTeam[weekServiceKey] || {};
        Object.keys(teamsForKey).forEach(function(tn) {
          teamRows.push({week: week, service_id: serviceId, team_name: tn,
            count: Object.keys(teamsForKey[tn]).length});
        });
        Logger.log(week + ' ' + campusName + ' ' + label + ': ' + count + ' unique scheduled people');
      });
    });
    Object.keys(observedWeekServices).filter(function(key) {
      return labels.indexOf(key.split('|')[1]) === -1;
    }).forEach(function(key) {
        Logger.log('Skipped unmatched Planning Center service time for ' + campusName + ': ' + key);
      });
  });

  if (rows.length) sbUpsert_(rows, token);
  sbReplaceTeamRows_(syncedWeekServices, teamRows, token);
  Logger.log('PCO Services scheduled-volunteer sync (' + weekCount + ' week' +
    (weekCount === 1 ? '' : 's') + '): ' + JSON.stringify(rows));
}

/** Replace the per-team volunteer rows for the synced week/services. */
function sbReplaceTeamRows_(weekServices, teamRows, accessTok) {
  weekServices.forEach(function(ws) {
    var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/volunteer_teams?week=eq.' + ws.week +
      '&service_id=eq.' + ws.service_id, {
      method: 'delete',
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + accessTok },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) throw new Error('volunteer_teams delete failed: ' + res.getContentText());
  });
  if (!teamRows.length) { Logger.log('volunteer_teams: no team rows to sync'); return; }
  var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/volunteer_teams?on_conflict=week,service_id,team_name', {
    method: 'post', contentType: 'application/json',
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + accessTok,
      Prefer: 'resolution=merge-duplicates,return=minimal' },
    payload: JSON.stringify(teamRows),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('volunteer_teams upsert failed: ' + res.getContentText());
  Logger.log('volunteer_teams: ' + teamRows.length + ' team rows synced');
}

/** Run manually to confirm the folder names/IDs visible to the PCO token. */
function listPCOServicesFolders() {
  pcoGetAll_('/services/v2/folders?per_page=100').forEach(function(folder) {
    Logger.log('SERVICES FOLDER ' + folder.id + '  "' + folder.attributes.name + '"');
  });
}

function pcoFolderServiceTypes_(folderId, seen) {
  if (seen[folderId]) return [];
  seen[folderId] = true;
  var found = pcoGetAll_('/services/v2/folders/' + folderId + '/service_types?per_page=100');
  var children = pcoGetAll_('/services/v2/folders/' + folderId + '/folders?per_page=100');
  children.forEach(function(child) {
    found = found.concat(pcoFolderServiceTypes_(child.id, seen));
  });
  return found;
}

function pcoServiceLabel_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'h:mm a');
}

/* ================= helpers ================= */

function sbSignIn_() {
  const p = PropertiesService.getScriptProperties();
  const res = UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'post', contentType: 'application/json',
    headers: { apikey: ANON_KEY },
    payload: JSON.stringify({ email: p.getProperty('SB_EMAIL'), password: p.getProperty('SB_PASSWORD') })
  });
  const d = JSON.parse(res.getContentText());
  if (!d.access_token) throw new Error('Supabase sign-in failed');
  return d.access_token;
}

function sbServices_(token) {
  const get = function(t) {
    return JSON.parse(UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/' + t + '?select=*', {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token }
    }).getContentText());
  };
  const campuses = get('campuses'), services = get('services');
  const cname = {}; campuses.forEach(function(c){ cname[c.id] = c.name; });
  const map = {};
  services.forEach(function(s){ map[cname[s.campus_id] + '|' + s.label] = s.id; });
  return map;
}

function sbUpsert_(rows, token) {
  // PostgREST bulk upserts need identical columns per batch — group by shape
  const groups = {};
  rows.forEach(function(r) {
    const k = Object.keys(r).sort().join(',');
    (groups[k] = groups[k] || []).push(r);
  });
  Object.keys(groups).forEach(function(k) {
    const res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/entries?on_conflict=week,service_id', {
      method: 'post', contentType: 'application/json',
      headers: {
        apikey: ANON_KEY, Authorization: 'Bearer ' + token,
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      payload: JSON.stringify(groups[k]),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) throw new Error('Upsert failed: ' + res.getContentText());
  });
}

function pcoGet_(path) {
  const p = PropertiesService.getScriptProperties();
  const url = /^https:\/\//.test(path) ? path : 'https://api.planningcenteronline.com' + path;
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(
      p.getProperty('PCO_APP_ID') + ':' + p.getProperty('PCO_SECRET')) },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('PCO error: ' + res.getContentText());
  return JSON.parse(res.getContentText());
}

function pcoGetAll_(path) {
  var data = [], next = path, pages = 0;
  while (next) {
    if (++pages > 100) throw new Error('PCO pagination exceeded 100 pages for ' + path);
    var response = pcoGet_(next);
    data = data.concat(response.data || []);
    next = response.links && response.links.next ? response.links.next : null;
  }
  return data;
}

function sundayISO_(d) {
  const x = new Date(d); x.setHours(12, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x.toISOString().slice(0, 10);
}
/** True when a mapping is the only one for its event on that weekday, so
 *  time-of-day matching can safely fall back to any time that day. */
function soloMapping_(m) {
  return PCO_EVENT_MAP.filter(function(x) {
    return x.eventId === m.eventId && x.day === m.day;
  }).length === 1;
}
function hhmm_(d) {
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}
function setNum_(obj, key, v) {
  if (v !== '' && v != null && !isNaN(Number(v))) obj[key] = Number(v);
}


/* ================= LIVE BACKUP TAB =================
 * syncBackup() mirrors the ENTIRE CampusMetrics database into a
 * "CampusMetrics Backup" tab of this spreadsheet.
 * Trigger: Time-driven, every hour (or every 15 min if you like).
 */

const BACKUP_SHEET = 'CampusMetrics Backup';
const ALL_METRICS  = ['adults','kids','volunteers','salvations','baptisms'];

function syncBackup() {
  const token = sbSignIn_();
  const campuses = sbFetchAll_('campuses', token);
  const services = sbFetchAll_('services', token);
  const entries  = sbFetchAll_('entries',  token);

  const campusById = {}; campuses.forEach(function(c){ campusById[c.id] = c; });
  const svcById = {};    services.forEach(function(s){ svcById[s.id] = s; });

  const header = ['week','campus','service'].concat(ALL_METRICS).concat(['updated_at']);
  const rows = entries.filter(function(e){ return svcById[e.service_id]; })
    .map(function(e) {
      const svc = svcById[e.service_id];
      const cam = campusById[svc.campus_id] || {name:'?'};
      return [e.week, cam.name, svc.label]
        .concat(ALL_METRICS.map(function(m){ return e[m] == null ? '' : e[m]; }))
        .concat([e.updated_at || '']);
    })
    .sort(function(a,b){ return (a[0]+a[1]+a[2] < b[0]+b[1]+b[2]) ? -1 : 1; });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(BACKUP_SHEET);
  if (!sheet) sheet = ss.insertSheet(BACKUP_SHEET);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  sheet.getRange(1, header.length + 2).setValue('Last synced: ' + new Date().toLocaleString());
  Logger.log('Backup: ' + rows.length + ' rows mirrored');
}

/* ================= WEEKLY EMAIL REPORTS =================
 * Sunday report: current Sunday services, sent Sunday afternoon.
 * Wednesday report: current week's Wednesday services, sent Thursday morning.
 * Both include the previous week's attendance for comparison and flag missing rows.
 */

function sendSundayMetricsEmail() {
  sendMetricsReport_('Sunday', function(campusName, serviceLabel) {
    var configured = SERVICE_MAP[campusName] || {};
    return Object.keys(configured).some(function(key) {
      return configured[key] === serviceLabel;
    });
  });
}

function sendWednesdayMetricsEmail() {
  var mapped = {};
  PCO_EVENT_MAP.filter(function(m) { return m.day === 3; }).forEach(function(m) {
    mapped[m.campus + '|' + m.service] = true;
  });
  var hasMappings = Object.keys(mapped).length > 0;

  sendMetricsReport_('Wednesday', function(campusName, serviceLabel) {
    if (hasMappings) return !!mapped[campusName + '|' + serviceLabel];
    return /\((wed|wednesday)\)/i.test(serviceLabel);
  });
}

function sendMetricsReport_(reportName, includeService) {
  var token = sbSignIn_();
  var campuses = sbFetchAll_('campuses', token);
  var services = sbFetchAll_('services', token);
  var entries = sbFetchAll_('entries', token);
  var campusById = {};
  campuses.forEach(function(c) { campusById[c.id] = c; });

  var week = sundayISO_(new Date());
  var previousDate = new Date(week + 'T12:00:00');
  previousDate.setDate(previousDate.getDate() - 7);
  var previousWeek = sundayISO_(previousDate);
  var entryByKey = {};
  entries.forEach(function(e) { entryByKey[e.week + '|' + e.service_id] = e; });

  var reportServices = services.filter(function(s) {
    var campus = campusById[s.campus_id];
    return campus && includeService(campus.name, s.label);
  }).sort(function(a, b) {
    var ca = campusById[a.campus_id], cb = campusById[b.campus_id];
    return ((ca.sort_order || 0) - (cb.sort_order || 0)) ||
      ca.name.localeCompare(cb.name) ||
      ((a.sort_order || 0) - (b.sort_order || 0)) ||
      a.label.localeCompare(b.label);
  });

  if (!reportServices.length) {
    throw new Error('No ' + reportName + ' services are configured. Add the service rows or complete PCO_EVENT_MAP first.');
  }

  var rows = reportServices.map(function(s) {
    var current = entryByKey[week + '|' + s.id] || null;
    var previous = entryByKey[previousWeek + '|' + s.id] || null;
    var adults = reportNumber_(current, 'adults');
    var kids = reportNumber_(current, 'kids');
    var previousAdults = reportNumber_(previous, 'adults');
    var previousKids = reportNumber_(previous, 'kids');
    var hasData = current && ['adults','kids','volunteers','salvations','baptisms']
      .some(function(metric) { return current[metric] != null; });
    return {
      campus: campusById[s.campus_id].name,
      service: s.label,
      sanctuary: adults,
      kids: kids,
      previousSanctuary: previousAdults,
      previousKids: previousKids,
      attendance: adults + kids,
      previousAttendance: previousAdults + previousKids,
      volunteers: reportNumber_(current, 'volunteers'),
      salvations: reportNumber_(current, 'salvations'),
      baptisms: reportNumber_(current, 'baptisms'),
      missing: !hasData
    };
  });

  var totals = rows.reduce(function(out, row) {
    out.sanctuary += row.sanctuary;
    out.kids += row.kids;
    out.previousSanctuary += row.previousSanctuary;
    out.previousKids += row.previousKids;
    out.attendance += row.attendance;
    out.previousAttendance += row.previousAttendance;
    out.volunteers += row.volunteers;
    out.salvations += row.salvations;
    out.baptisms += row.baptisms;
    if (row.missing) out.missing++;
    return out;
  }, {sanctuary:0, kids:0, previousSanctuary:0, previousKids:0,
      attendance:0, previousAttendance:0, volunteers:0, salvations:0, baptisms:0, missing:0});

  var recipients = reportRecipients_();
  if (!recipients || !recipients.trim()) {
    throw new Error('Missing Script Property ' + REPORT_RECIPIENTS_PROPERTY + '. Add one or more comma-separated email addresses.');
  }

  var dateLabel = reportDateLabel_(week);
  var subject = 'CampusMetrics ' + reportName + ' report — ' + dateLabel;
  var comparison = reportDelta_(totals.attendance, totals.previousAttendance);
  var sanctuaryComparison = reportDelta_(totals.sanctuary, totals.previousSanctuary);
  var kidsComparison = reportDelta_(totals.kids, totals.previousKids);
  var missingText = totals.missing
    ? totals.missing + ' service' + (totals.missing === 1 ? '' : 's') + ' missing data'
    : 'All configured services reported';
  var textRows = rows.map(function(row) {
    return row.campus + ' · ' + row.service + ': ' +
      (row.missing ? 'MISSING' : row.sanctuary + ' sanctuary, ' + row.kids + ' kids, ' +
        row.attendance + ' total attendance (' +
        reportDelta_(row.attendance, row.previousAttendance) + '), ' +
        row.volunteers + ' volunteers, ' + row.salvations + ' salvations, ' + row.baptisms + ' baptisms');
  }).join('\n');
  var body = reportName + ' metrics for ' + dateLabel + '\n\n' +
    'Sanctuary: ' + totals.sanctuary + ' (' + sanctuaryComparison + ')\n' +
    'Kids: ' + totals.kids + ' (' + kidsComparison + ')\n' +
    'Total attendance: ' + totals.attendance + ' (' + comparison + ')\n' +
    'Volunteers: ' + totals.volunteers + '\n' +
    'Salvations: ' + totals.salvations + '\n' +
    'Baptisms: ' + totals.baptisms + '\n' +
    'Status: ' + missingText + '\n\n' + textRows;

  var htmlRows = rows.map(function(row) {
    var background = row.missing ? ' style="background:#fff1f2"' : '';
    return '<tr' + background + '>' +
      '<td style="padding:8px;border-bottom:1px solid #e2e8f0"><b>' + reportEscape_(row.campus) + '</b><br>' + reportEscape_(row.service) + '</td>' +
      '<td style="padding:8px;text-align:center;border-bottom:1px solid #e2e8f0">' + (row.missing ? '<b style="color:#be123c">Missing</b>' : row.sanctuary) + '</td>' +
      '<td style="padding:8px;text-align:center;border-bottom:1px solid #e2e8f0">' + (row.missing ? '—' : row.kids) + '</td>' +
      '<td style="padding:8px;text-align:center;border-bottom:1px solid #e2e8f0">' + (row.missing ? '—' : row.attendance) + '</td>' +
      '<td style="padding:8px;text-align:center;border-bottom:1px solid #e2e8f0">' + (row.missing ? '—' : reportEscape_(reportDelta_(row.attendance, row.previousAttendance))) + '</td>' +
      '<td style="padding:8px;text-align:center;border-bottom:1px solid #e2e8f0">' + (row.missing ? '—' : row.volunteers) + '</td>' +
      '<td style="padding:8px;text-align:center;border-bottom:1px solid #e2e8f0">' + (row.missing ? '—' : row.salvations) + '</td>' +
      '<td style="padding:8px;text-align:center;border-bottom:1px solid #e2e8f0">' + (row.missing ? '—' : row.baptisms) + '</td>' +
      '</tr>';
  }).join('');
  var htmlBody = '<div style="font-family:Arial,sans-serif;color:#1a202c;max-width:760px">' +
    '<h2 style="margin-bottom:4px">CampusMetrics ' + reportEscape_(reportName) + ' report</h2>' +
    '<p style="margin-top:0;color:#64748b">Week of ' + reportEscape_(dateLabel) + '</p>' +
    '<div style="padding:14px;background:#eef2ff;border-radius:8px;margin:16px 0">' +
      '<b style="font-size:20px">' + totals.attendance + ' total attendance</b> &nbsp; ' + reportEscape_(comparison) + '<br>' +
      '<b>' + totals.sanctuary + ' sanctuary</b> (' + reportEscape_(sanctuaryComparison) + ') &nbsp;·&nbsp; ' +
      '<b>' + totals.kids + ' kids</b> (' + reportEscape_(kidsComparison) + ')<br>' +
      totals.volunteers + ' volunteers &nbsp;·&nbsp; ' + totals.salvations + ' salvations &nbsp;·&nbsp; ' + totals.baptisms + ' baptisms<br>' +
      '<span style="color:' + (totals.missing ? '#be123c' : '#047857') + '">' + reportEscape_(missingText) + '</span></div>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
      '<thead><tr style="background:#f8fafc"><th style="padding:8px;text-align:left">Campus / service</th><th>Sanctuary</th><th>Kids</th><th>Total</th><th>vs prior week</th><th>Volunteers</th><th>Salvations</th><th>Baptisms</th></tr></thead>' +
      '<tbody>' + htmlRows + '</tbody></table>' +
    '<p style="color:#64748b;font-size:12px;margin-top:18px">Sent automatically by CampusMetrics.</p></div>';

  MailApp.sendEmail({
    to: recipients.trim(),
    subject: subject,
    body: body,
    htmlBody: htmlBody,
    name: 'CampusMetrics'
  });
  Logger.log(subject + ' sent to ' + recipients.trim());
}

/** Run once after setting REPORT_RECIPIENTS. Managed triggers are replaced safely. */
function installEmailReportTriggers() {
  var handlers = ['syncPCOKids', 'syncPCOScheduledVolunteers', 'sendMissingUsherEntryAlert',
    'sendSundayMetricsEmail', 'sendWednesdayMetricsEmail'];
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (handlers.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('syncPCOKids').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('syncPCOScheduledVolunteers').timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(13).create();
  ScriptApp.newTrigger('sendMissingUsherEntryAlert').timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(SUNDAY_REPORT_HOUR).nearMinute(0).create();
  ScriptApp.newTrigger('sendSundayMetricsEmail').timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(SUNDAY_REPORT_HOUR).create();
  ScriptApp.newTrigger('sendWednesdayMetricsEmail').timeBased()
    .onWeekDay(ScriptApp.WeekDay.THURSDAY).atHour(THURSDAY_REPORT_HOUR).create();
  Logger.log('Automation triggers installed in ' + Session.getScriptTimeZone() +
    ': Check-Ins hourly on Sundays/Wednesdays, scheduled volunteers Sunday around 1pm, ' +
    'missing-entry check and Sunday report around 2pm, and Thursday report around 8am.');
}

function reportNumber_(row, metric) {
  return row && row[metric] != null && !isNaN(Number(row[metric])) ? Number(row[metric]) : 0;
}

function reportDelta_(current, previous) {
  if (!previous) return current ? 'new vs prior week' : 'no prior-week data';
  var percent = Math.round((current - previous) / previous * 100);
  if (!percent) return 'flat vs prior week';
  return (percent > 0 ? '+' : '') + percent + '% vs prior week';
}

function reportDateLabel_(week) {
  return Utilities.formatDate(new Date(week + 'T12:00:00'), Session.getScriptTimeZone(), 'MMM d, yyyy');
}

function reportEscape_(value) {
  return String(value).replace(/[&<>"']/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function sbFetchAll_(table, token) {
  const out = []; let from = 0; const page = 1000;
  while (true) {
    const res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/' + table + '?select=*', {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token,
                 Range: from + '-' + (from + page - 1) }
    });
    const batch = JSON.parse(res.getContentText());
    out.push.apply(out, batch);
    if (batch.length < page) break;
    from += page;
  }
  return out;
}

/* ================= NEXT STEPS (added 2026-10-08, v2) =================
 * Feeds the "Next Steps" tab in DestinyMetrics.
 *  - Decisions for Christ: people on each campus's connect-card decision workflow (PCO People)
 *  - Baptism interest: people on each campus's "I want to be baptized" connect-card workflow
 *  - Baptism registrations: attendees of the "Baptism Sunday" signup (PCO Registrations),
 *    campus taken from the option they picked.
 * Hands raised + baptized counts already come from the usher form (salvations / baptisms).
 * Runs hourly via installNextStepsTrigger(); safe to run by hand any time (it upserts by id).
 * Every run records success/failure in the Supabase sync_status table (the app shows it),
 * and a failure emails the alert recipients at most once a day.
 */
const NEXT_STEPS_DECISION_WORKFLOWS = { 'Columbia': '436515', 'Lewisburg': '426876', 'Shelbyville': '665330' };
const NEXT_STEPS_BAPTISM_WORKFLOWS  = { 'Columbia': '436544', 'Lewisburg': '426873', 'Shelbyville': '665323' };
const NEXT_STEPS_BAPTISM_SIGNUP = '2234946';
const PCO_API_ROOT_ = 'https://api.planningcenteronline.com';
const NEXT_STEPS_ALERT_PROPERTY = 'NEXT_STEPS_LAST_ALERT';

function syncNextSteps() {
  try {
    const result = syncNextSteps_();
    nextStepsReport_(true, result.rows, null, result.meta);
    Logger.log('Next steps synced: ' + result.rows + ' rows (' + result.summary + ')');
    try { ensureGrowthTrackStep3Trigger_(); } catch (e3) { Logger.log('GT Step3 trigger ensure: ' + e3); }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    try { nextStepsReport_(false, null, msg, null); } catch (e2) { Logger.log('Could not record failure: ' + e2); }
    nextStepsAlert_(msg);
    throw err;
  }
}

function syncNextSteps_() {
  const token = sbSignIn_();
  const headers = { apikey: ANON_KEY, Authorization: 'Bearer ' + token };
  const campusId = {};
  JSON.parse(UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/campuses?select=id,name', { headers: headers }).getContentText())
    .forEach(function (c) { campusId[c.name] = c.id; });
  const rows = [];
  const counts = { decision: 0, baptism_interest: 0, baptism_reg: 0 };

  const pullWorkflows = function (map, source) {
    Object.keys(map).forEach(function (campus) {
      if (!campusId[campus]) return;
      nextStepsPages_(PCO_API_ROOT_ + '/people/v2/workflows/' + map[campus] + '/cards?include=person&per_page=100', function (card, inc) {
        const pid = card.relationships && card.relationships.person && card.relationships.person.data && card.relationships.person.data.id;
        const a = card.attributes;
        rows.push({
          id: source + ':' + card.id, source: source, campus_id: campusId[campus],
          week: sundayISO_(new Date(a.created_at)), occurred_at: a.created_at,
          person_name: nextStepsName_(pid ? inc['Person:' + pid] : null), pco_person_id: pid || null,
          status: a.stage || 'ready', completed_at: a.completed_at || null, pco_updated_at: a.updated_at || null,
          pco_url: pid ? 'https://people.planningcenteronline.com/people/AC' + pid : null
        });
        counts[source]++;
      });
    });
  };
  pullWorkflows(NEXT_STEPS_DECISION_WORKFLOWS, 'decision');
  pullWorkflows(NEXT_STEPS_BAPTISM_WORKFLOWS, 'baptism_interest');

  nextStepsPages_(PCO_API_ROOT_ + '/registrations/v2/signups/' + NEXT_STEPS_BAPTISM_SIGNUP +
      '/attendees?include=person,selection_type&per_page=100', function (att, inc) {
    const rel = att.relationships || {};
    const sid = rel.selection_type && rel.selection_type.data && rel.selection_type.data.id;
    const sel = sid ? inc['SelectionType:' + sid] : null;
    const selName = (sel && sel.attributes && sel.attributes.name) || '';
    const campus = Object.keys(campusId).filter(function (n) { return selName.toLowerCase().indexOf(n.toLowerCase()) >= 0; })[0];
    if (!campus) return;   // no campus option chosen
    const pid = rel.person && rel.person.data && rel.person.data.id;
    const a = att.attributes;
    rows.push({
      id: 'baptism_reg:' + att.id, source: 'baptism_reg', campus_id: campusId[campus],
      week: sundayISO_(new Date(a.created_at)), occurred_at: a.created_at,
      person_name: nextStepsName_(pid ? inc['Person:' + pid] : null), pco_person_id: pid || null,
      status: a.canceled ? 'canceled' : (a.waitlisted ? 'waitlisted' : 'active'),
      completed_at: null, pco_updated_at: a.updated_at || null,
      pco_url: 'https://registrations.planningcenteronline.com/signups/' + NEXT_STEPS_BAPTISM_SIGNUP
    });
    counts.baptism_reg++;
  });

  for (var i = 0; i < rows.length; i += 200) {
    const res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/next_steps_upsert', {
      method: 'post', contentType: 'application/json', headers: headers,
      payload: JSON.stringify({ rows: rows.slice(i, i + 200) }), muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) throw new Error('Next steps upsert failed: ' + res.getContentText());
  }

  // Date of the next Baptism Sunday, so the app can label the upcoming event. Never fatal.
  const meta = { counts: counts };
  try {
    const signup = pcoGet_(PCO_API_ROOT_ + '/registrations/v2/signups/' + NEXT_STEPS_BAPTISM_SIGNUP + '?include=next_signup_time');
    const t = (signup.included || []).filter(function (x) { return x.type === 'SignupTime'; })[0];
    if (t && t.attributes && t.attributes.starts_at) meta.next_baptism = sundayISO_(new Date(t.attributes.starts_at));
  } catch (e) { Logger.log('Could not read the next Baptism Sunday date: ' + e); }

  // A decision workflow that suddenly has no cards usually means it was archived/replaced in PCO.
  Object.keys(counts).forEach(function (k) { if (!counts[k]) throw new Error('Planning Center returned 0 records for ' + k + ' - check that the workflow/signup still exists'); });

  return { rows: rows.length, meta: meta,
    summary: counts.decision + ' decisions, ' + counts.baptism_interest + ' baptism interest, ' + counts.baptism_reg + ' baptism registrations' };
}

/** Records the result of a run in Supabase (sync_status) so the app can show "last synced". */
function nextStepsReport_(ok, rowCount, message, meta) {
  const token = sbSignIn_();
  const res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/sync_report', {
    method: 'post', contentType: 'application/json',
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ p_job: 'next_steps', p_ok: ok, p_rows: rowCount, p_message: message, p_meta: meta }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('sync_report failed: ' + res.getContentText());
}
/** Emails the alert recipients about a failed run, at most once every 24 hours. */
function nextStepsAlert_(msg) {
  try {
    const p = PropertiesService.getScriptProperties();
    const last = Number(p.getProperty(NEXT_STEPS_ALERT_PROPERTY) || 0);
    if (Date.now() - last < 24 * 60 * 60 * 1000) return;
    var to = alertRecipients_();
    if (to && to.join) to = to.join(',');
    if (!to) return;
    MailApp.sendEmail(String(to), 'DestinyMetrics: Next Steps sync failed',
      'The hourly Planning Center sync for the Next Steps tab failed.\n\n' + msg +
      '\n\nThe tab will keep showing the last numbers that loaded. If a workflow or the Baptism Sunday signup was ' +
      'archived or replaced in Planning Center, update the ids at the top of the NEXT STEPS section of the Usher Form Apps Script.');
    p.setProperty(NEXT_STEPS_ALERT_PROPERTY, String(Date.now()));
  } catch (e) { Logger.log('Could not send alert: ' + e); }
}

/** Walks every page of a PCO list, handing each record plus that page's included records to fn. */
function nextStepsPages_(url, fn) {
  var next = url, pages = 0;
  while (next) {
    if (++pages > 100) throw new Error('PCO pagination exceeded 100 pages for ' + url);
    const res = pcoGet_(next);
    const inc = {};
    (res.included || []).forEach(function (x) { inc[x.type + ':' + x.id] = x; });
    (res.data || []).forEach(function (d) { fn(d, inc); });
    next = res.links && res.links.next ? res.links.next : null;
  }
}
function nextStepsName_(person) {
  if (!person || !person.attributes) return null;
  const a = person.attributes;
  return a.name || [a.first_name, a.last_name].filter(function (x) { return x; }).join(' ') || null;
}
/** Run once to start the hourly Next Steps sync. */
function installNextStepsTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncNextSteps') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncNextSteps').timeBased().everyHours(1).create();
}

/* ================= BACKGROUND CHECK HEADS-UP EMAIL (web app) =================
 * The metrics app's Volunteers tab → "Background checks needed" → Order posts
 * {access_token, gt_id} here (Content-Type text/plain, so no CORS preflight).
 * We verify the caller is a signed-in CampusMetrics admin, look up the person,
 * find their email (PCO first, then the Growth Track row), and send a heads-up
 * from the script owner (Zach). A send is logged on the growth_track_people
 * row (bg_email_sent_at/to/template) and not repeated within 24 hours.
 * Deploy: Deploy → New deployment → Web app, Execute as: Me, Who has access: Anyone.
 */
const BG_EMAIL_DEDUPE_HOURS = 24;
const BG_EMAIL_SENDER_NAME = 'Zach Taylor';
const BG_EMAIL_TEMPLATES = {
  FIRST: {
    subject: 'A quick heads-up about your background check',
    paragraphs: [
      'Thank you so much for finishing Growth Track and stepping up to serve on the Dream Team! As part of getting you set up, we\'re ordering a background check for you. We do this for every one of our volunteers. It helps us keep our church family, especially our kids, safe.',
      'You\'ll get an email soon from Protect My Ministry with a link to fill out a short consent form. The link expires after 14 days, so please complete it when you see it. If you have any questions, just reply to this email.'
    ]
  },
  REORDER: {
    subject: 'A new background check link is on the way',
    paragraphs: [
      'Thank you for serving on the Dream Team! It looks like the last background check link we sent you expired before it was completed, so we\'re sending you a new one. We do this for every one of our volunteers. It helps us keep our church family, especially our kids, safe.',
      'You\'ll get an email soon from Protect My Ministry with a fresh link to fill out a short consent form. It expires after 14 days, so please complete it when you see it. If you have any questions, just reply to this email.'
    ]
  }
};

function doPost(e) {
  var out;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action && body.action !== 'bg_order_email') out = { sent: false, error: 'unknown_action' };
    else out = bgOrderEmail_(body);
  } catch (err) {
    out = { sent: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function bgSb_(method, path, token, payload) {
  var opts = {
    method: method, muteHttpExceptions: true,
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token }
  };
  if (payload) {
    opts.contentType = 'application/json';
    opts.payload = JSON.stringify(payload);
    opts.headers.Prefer = 'return=minimal';
  }
  var res = UrlFetchApp.fetch(SUPABASE_URL + path, opts);
  var code = res.getResponseCode(), text = res.getContentText();
  if (code >= 300) throw new Error('Supabase ' + code + ': ' + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}

function bgOrderEmail_(body) {
  var token = String(body.access_token || ''), gtId = String(body.gt_id || '');
  if (!token) return { sent: false, error: 'not_signed_in' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(gtId)) return { sent: false, error: 'bad_gt_id' };

  // 1. Who is calling? Must be a signed-in admin (checked with their own token under RLS).
  var user;
  try { user = bgSb_('get', '/auth/v1/user', token); } catch (err) { return { sent: false, error: 'not_signed_in' }; }
  if (!user || !user.id) return { sent: false, error: 'not_signed_in' };
  var prof = bgSb_('get', '/rest/v1/profiles?select=role&id=eq.' + encodeURIComponent(user.id), token);
  if (!prof || !prof.length || prof[0].role !== 'admin') return { sent: false, error: 'not_admin' };

  // One send at a time so a double-click can't send twice.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { sent: false, error: 'busy_try_again' };
  try {
    // 2. The Growth Track person.
    var rows = bgSb_('get', '/rest/v1/growth_track_people?select=id,name,email,pco_person_id,bg_reason,bg_last_status,bg_status,bg_email_sent_at,bg_email_to&id=eq.' + gtId, token);
    if (!rows || !rows.length) return { sent: false, error: 'not_found' };
    var r = rows[0];
    if (r.bg_status !== 'needed' && r.bg_status !== 'ordered') return { sent: false, error: 'not_on_list' };

    // 3. Don't resend within 24 hours.
    if (r.bg_email_sent_at && (Date.now() - new Date(r.bg_email_sent_at).getTime()) < BG_EMAIL_DEDUPE_HOURS * 3600 * 1000) {
      return { sent: false, reason: 'already_sent', to: r.bg_email_to, sent_at: r.bg_email_sent_at };
    }

    // 4. Find an email: PCO (primary first), then the Growth Track row.
    var to = '';
    if (r.pco_person_id && /^\d+$/.test(String(r.pco_person_id))) {
      try { to = bgPcoEmail_(String(r.pco_person_id)); } catch (err) { Logger.log('PCO email lookup failed for ' + r.pco_person_id + ': ' + err); }
    }
    if (!to && r.email && /@/.test(r.email)) to = String(r.email).trim();
    if (!to) return { sent: false, reason: 'no_email' };

    // 5. Template + send from the script owner.
    var templateKey = bgTemplateKey_(r);
    var msg = bgEmailContent_(templateKey, r.name);
    MailApp.sendEmail({ to: to, subject: msg.subject, body: msg.text, htmlBody: msg.html, name: BG_EMAIL_SENDER_NAME });

    // 6. Log it on the row (with the admin's token; the DB guard allows admins only).
    var sentAt = new Date().toISOString(), warning = null;
    try {
      bgSb_('patch', '/rest/v1/growth_track_people?id=eq.' + gtId, token,
        { bg_email_sent_at: sentAt, bg_email_to: to, bg_email_template: templateKey });
    } catch (err) {
      warning = 'sent_but_not_logged: ' + err.message;
      Logger.log(warning);
    }
    return { sent: true, to: to, template: templateKey, sent_at: sentAt, warning: warning };
  } finally {
    lock.releaseLock();
  }
}

function bgPcoEmail_(pcoId) {
  var list = (pcoGet_('/people/v2/people/' + pcoId + '/emails').data || [])
    .map(function (d) { return d.attributes || {}; })
    .filter(function (a) { return a.address && /@/.test(a.address) && !a.blocked; });
  list.sort(function (a, b) { return (b.primary ? 1 : 0) - (a.primary ? 1 : 0); });
  return list.length ? String(list[0].address).trim() : '';
}

/** 'Never checked' with nothing on file → FIRST; an expired invite or any prior check → REORDER. */
function bgTemplateKey_(r) {
  var reason = String(r.bg_reason || ''), last = String(r.bg_last_status || '');
  var priorOnFile = last && !/^no check on file$/i.test(last.trim());
  return (/never checked/i.test(reason) && !priorOnFile) ? 'FIRST' : 'REORDER';
}

function bgEmailContent_(templateKey, fullName) {
  var t = BG_EMAIL_TEMPLATES[templateKey];
  var first = String(fullName || '').trim().split(/\s+/)[0] || 'there';
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var text = 'Hi ' + first + ',\n\n' + t.paragraphs.join('\n\n') + '\n\nThanks for serving with us!\nZach';
  var html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222">'
    + '<p>Hi ' + esc(first) + ',</p>'
    + t.paragraphs.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('')
    + '<p>Thanks for serving with us!<br>Zach</p></div>';
  return { subject: t.subject, text: text, html: html };
}

/* ================= GROWTH TRACK STEP 3 → PCO FORM 551600 =================
 * When someone first has all 3 Growth Track step dates + a mappable
 * team_preference + a pco_person_id, POST a submission to Church Center form
 * 551600 (DC - Growth Track Step 3) so each picked team's onboarding workflow
 * fires, plus the Columbia Growth Track Complete F/U workflow.
 *
 * Rules (Zach-approved 2026-10-23):
 *   - Strict all-3-steps; skip if form_551600_submission_id already set
 *   - Skip if they already have any submission on form 551600 in PCO
 *   - Skip minors (age < 18 from PCO birthdate; no birthdate → proceed, log)
 *   - Skip prefs marked "WF's Added"; skip people with no mappable teams
 *   - Always check follow-up option 11178283
 *   - Phone optional from the GT row
 *
 * Run manually: syncGrowthTrackStep3Forms()           // live submit
 *               dryRunGrowthTrackStep3Forms()         // log only, no POST
 * Attach a time-driven trigger later (do NOT create until Zach says so), e.g.
 *   ScriptApp.newTrigger('syncGrowthTrackStep3Forms').timeBased().everyHours(6).create();
 * Or add syncGrowthTrackStep3Forms() to installEmailReportTriggers once approved.
 */
const GT_STEP3_FORM_ID = '551600';
const GT_STEP3_FIELD_PHONE = '4284743';
const GT_STEP3_FIELD_TEAMS = '4284740';
const GT_STEP3_FIELD_FOLLOWUP = '10116995';
const GT_STEP3_OPTION_FOLLOWUP = '11178283';

/** Form-option label → FormFieldOption id for field 4284740. */
const GT_STEP3_TEAM_OPTIONS = {
  'Greeter': '4657995',
  'DK Elementary (Pre-K - 5th Grade)': '4657999',
  'Connection Team (Admin)': '10790272',
  'Creative (Graphics/Media)': '4657996',
  'Outreach': '10790273',
  'Events': '10790274',
  'Parking': '10790275',
  'LifeGroup Leader': '10790382',
  'Audio/Visual/Lighting': '4657997',
  'Music (Band/Vocals)': '4657994',
  'DK Nursery/Toddler (0 - 3)': '10790383',
  'Youth (Middle/High School)': '4658000',
  'PitCrew (Facilities)': '4657998',
  'Growth Track': '10790278',
  'Prayer': '10790279',
  'Safety': '10790280',
  'Social Media': '11178070',
  'Photo/Video': '11178071',
  'Usher': '11178072',
  'Connect Center': '11178110'
};

/**
 * Alias regex (Apps Script RegExp) → option label. More specific first.
 * Door Greeter / Street to Seat / S2S / Greeting all map to Greeter.
 */
const GT_STEP3_TEAM_ALIASES = [
  { re: /connect(?:ion)?s?\s*team\s*admin|connect(?:ion)?s?\s*team/i, label: 'Connection Team (Admin)' },
  { re: /connect\s*ctr|connect\s*center/i, label: 'Connect Center' },
  { re: /door\s*greeter|street\s*to\s*seat(?:\s*\(greeting\))?|\bs2s\b|greeting/i, label: 'Greeter' },
  { re: /\bgreeter\b/i, label: 'Greeter' },
  { re: /dk\s*nurs|nurs(?:ery)?\/?toddler|\btoddler\b|\bnursery\b/i, label: 'DK Nursery/Toddler (0 - 3)' },
  { re: /dk\s*elem|elementry|elementary|\bkids\b/i, label: 'DK Elementary (Pre-K - 5th Grade)' },
  { re: /life\s*groups?\s*(?:host|leader)?|\blg\s*host\b|lifegroup/i, label: 'LifeGroup Leader' },
  { re: /photo\/?\s*vid|capture\s*team/i, label: 'Photo/Video' },
  { re: /social\s*media|\bsocials\b/i, label: 'Social Media' },
  { re: /audio\/?visual\/?lighting|\bavl?\b|\baudio\b|\blighting\b|\bproduction\b/i, label: 'Audio/Visual/Lighting' },
  { re: /pit\s*crews?|facilities/i, label: 'PitCrew (Facilities)' },
  { re: /creative|graphics/i, label: 'Creative (Graphics/Media)' },
  { re: /music|band|vocals?/i, label: 'Music (Band/Vocals)' },
  { re: /growth\s*track/i, label: 'Growth Track' },
  { re: /outreach(?:es)?/i, label: 'Outreach' },
  { re: /\bevents?\b/i, label: 'Events' },
  { re: /parking/i, label: 'Parking' },
  { re: /prayer/i, label: 'Prayer' },
  { re: /safety/i, label: 'Safety' },
  { re: /\busher\b/i, label: 'Usher' },
  { re: /youth|middle\/?high|6-12/i, label: 'Youth (Middle/High School)' }
];

/** Create (or replace) the every-6-hours form 551600 sync trigger. Safe to re-run. */

/** Idempotent: create the 6-hour form 551600 trigger if missing. Called from syncNextSteps. */
function ensureGrowthTrackStep3Trigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'syncGrowthTrackStep3Forms';
  });
  if (exists) return;
  ScriptApp.newTrigger('syncGrowthTrackStep3Forms').timeBased().everyHours(6).create();
  Logger.log('Growth Track Step 3 form sync trigger auto-installed (every 6 hours).');
}

function installGrowthTrackStep3Trigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'syncGrowthTrackStep3Forms') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('syncGrowthTrackStep3Forms').timeBased().everyHours(6).create();
  Logger.log('Growth Track Step 3 form sync trigger installed (every 6 hours, ' +
    Session.getScriptTimeZone() + ').');
}

function dryRunGrowthTrackStep3Forms() {
  return syncGrowthTrackStep3Forms({ dryRun: true });
}

/** Live submit for eligible people who do not yet have form_551600_submission_id. */
function syncGrowthTrackStep3Forms(opts) {
  opts = opts || {};
  var dryRun = !!opts.dryRun;
  var token = sbSignIn_();
  var rows = gtStep3FetchEligible_(token);
  var alreadyOnForm = gtStep3ExistingSubmitters_();
  var summary = { dryRun: dryRun, scanned: rows.length, submitted: 0, skipped: 0, errors: 0, details: [] };

  rows.forEach(function (r) {
    var decision = gtStep3Decide_(r, alreadyOnForm);
    if (!decision.wouldSubmit) {
      summary.skipped++;
      summary.details.push({ name: r.name, action: 'skip', reasons: decision.reasons, mapped: decision.mapped });
      Logger.log('GT Step3 SKIP ' + r.name + ' — ' + decision.reasons.join(', '));
      return;
    }
    if (dryRun) {
      summary.submitted++; // "would submit" count
      summary.details.push({ name: r.name, action: 'would_submit', mapped: decision.mapped, optionIds: decision.optionIds });
      Logger.log('GT Step3 WOULD SUBMIT ' + r.name + ' → ' + decision.mapped.join('; '));
      return;
    }
    try {
      var subId = submitGrowthTrackStep3Form_(r, decision.optionIds);
      gtStep3Stamp_(token, r.id, subId);
      alreadyOnForm[String(r.pco_person_id)] = true;
      summary.submitted++;
      summary.details.push({ name: r.name, action: 'submitted', submissionId: subId, mapped: decision.mapped });
      Logger.log('GT Step3 SUBMITTED ' + r.name + ' submission=' + subId);
    } catch (err) {
      summary.errors++;
      summary.details.push({ name: r.name, action: 'error', error: String(err && err.message || err) });
      Logger.log('GT Step3 ERROR ' + r.name + ': ' + err);
    }
  });

  Logger.log('GT Step3 done dryRun=' + dryRun +
    ' scanned=' + summary.scanned +
    ' submitted=' + summary.submitted +
    ' skipped=' + summary.skipped +
    ' errors=' + summary.errors);
  return summary;
}

/** Eligible = all 3 dates, non-empty team_preference, pco id, not yet stamped. */
function gtStep3FetchEligible_(token) {
  var path = '/rest/v1/growth_track_people'
    + '?select=id,name,phone,email,birth_date,pco_person_id,step1_date,step2_date,step3_date,team_preference,form_551600_submission_id'
    + '&step1_date=not.is.null&step2_date=not.is.null&step3_date=not.is.null'
    + '&team_preference=not.is.null'
    + '&form_551600_submission_id=is.null'
    + '&order=step3_date.asc,name';
  var res = UrlFetchApp.fetch(SUPABASE_URL + path, {
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('Supabase GT fetch: ' + res.getContentText().slice(0, 300));
  var rows = JSON.parse(res.getContentText() || '[]');
  return rows.filter(function (r) { return String(r.team_preference || '').trim(); });
}

/** person_id → true for anyone who already has a submission on form 551600. */
function gtStep3ExistingSubmitters_() {
  var map = {}, next = '/people/v2/forms/' + GT_STEP3_FORM_ID + '/form_submissions?per_page=100&order=-created_at', pages = 0;
  while (next) {
    if (++pages > 50) throw new Error('GT Step3: too many form_submission pages');
    var d = pcoGet_(next);
    (d.data || []).forEach(function (s) {
      var pid = s.relationships && s.relationships.person && s.relationships.person.data && s.relationships.person.data.id;
      if (pid) map[String(pid)] = true;
    });
    next = d.links && d.links.next ? d.links.next : null;
  }
  return map;
}

function gtStep3Decide_(r, alreadyOnForm) {
  var reasons = [], mapped = [], optionIds = [];
  var pref = String(r.team_preference || '');
  var pco = String(r.pco_person_id || '').trim();
  var parsed = gtStep3MapPreference_(pref);
  mapped = parsed.mapped;
  optionIds = parsed.optionIds;

  if (!/^\d+$/.test(pco)) reasons.push('no_pco');
  if (pco && alreadyOnForm[pco]) reasons.push('already_submitted');
  if (parsed.wfAdded) reasons.push('wf_added_marker');
  if (!mapped.length) reasons.push('no_mappable_teams');

  var ageInfo = gtStep3Age_(r, pco);
  if (ageInfo.under18) reasons.push('minor_age_' + ageInfo.age);
  if (ageInfo.noBirthdate) reasons.push('no_birthdate');

  var wouldSubmit = reasons.indexOf('no_pco') < 0
    && reasons.indexOf('already_submitted') < 0
    && reasons.indexOf('wf_added_marker') < 0
    && reasons.indexOf('no_mappable_teams') < 0
    && !ageInfo.under18;

  return {
    wouldSubmit: wouldSubmit,
    reasons: reasons.length ? reasons : ['ok'],
    mapped: mapped,
    optionIds: optionIds,
    unmapped: parsed.unmapped,
    age: ageInfo.age,
    noBirthdate: ageInfo.noBirthdate
  };
}

function gtStep3Age_(r, pco) {
  var bd = r.birth_date ? String(r.birth_date).slice(0, 10) : '';
  if (!bd && pco && /^\d+$/.test(pco)) {
    try {
      var a = pcoGet_('/people/v2/people/' + pco).data.attributes || {};
      bd = (a.birthdate || '').slice(0, 10);
    } catch (err) { /* ignore */ }
  }
  if (!bd) return { age: null, under18: false, noBirthdate: true };
  var parts = bd.split('-');
  if (parts.length !== 3) return { age: null, under18: false, noBirthdate: true };
  var born = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var now = new Date();
  var age = now.getFullYear() - born.getFullYear();
  var m = now.getMonth() - born.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < born.getDate())) age--;
  return { age: age, under18: age < 18, noBirthdate: false };
}

function gtStep3MapPreference_(pref) {
  var wfAdded = /wf'?s?\s*added/i.test(pref);
  var cleaned = String(pref || '').replace(/wf'?s?\s*added/ig, ' ');
  var parts = cleaned.split(/[,&+/]|\band\b/i).map(function (p) {
    return p.replace(/^in\s+order:\s*/i, '').replace(/^[\s.\-–—]+|[\s.\-–—]+$/g, '');
  }).filter(Boolean);

  var mapped = [], optionIds = [], unmapped = [], seen = {};
  function addLabel(label) {
    if (!label || seen[label]) return;
    var id = GT_STEP3_TEAM_OPTIONS[label];
    if (!id) return;
    seen[label] = true;
    mapped.push(label);
    optionIds.push(id);
  }
  parts.forEach(function (part) {
    if (/already\s*serves|left\s*gwp|not\s*a\s*growth\s*track\s*option|shepherding|10-*-*8\s*collective/i.test(part)) {
      unmapped.push(part);
      return;
    }
    var hit = null;
    for (var i = 0; i < GT_STEP3_TEAM_ALIASES.length; i++) {
      if (GT_STEP3_TEAM_ALIASES[i].re.test(part)) { hit = GT_STEP3_TEAM_ALIASES[i].label; break; }
    }
    if (hit) addLabel(hit);
    else unmapped.push(part);
  });
  // Greedy fallback on the whole string when splits found nothing
  if (!mapped.length && cleaned.trim()) {
    GT_STEP3_TEAM_ALIASES.forEach(function (a) {
      if (a.re.test(cleaned)) addLabel(a.label);
    });
    if (mapped.length) unmapped = [];
  }
  return { mapped: mapped, optionIds: optionIds, unmapped: unmapped, wfAdded: wfAdded };
}

/**
 * POST one FormSubmission for this GT person. Returns the new submission id.
 * Always includes follow-up option 11178283. One FormSubmissionValue per team option.
 */
function submitGrowthTrackStep3Form_(person, optionIds) {
  if (!optionIds || !optionIds.length) throw new Error('no option ids');
  var pco = String(person.pco_person_id);
  var included = [];
  var phoneDigits = gtStep3PhoneDigits_(person.phone);
  if (phoneDigits) {
    included.push({
      type: 'FormSubmissionValue',
      attributes: { form_field_id: GT_STEP3_FIELD_PHONE, number: phoneDigits, location: 'Mobile' }
    });
  }
  optionIds.forEach(function (oid) {
    included.push({
      type: 'FormSubmissionValue',
      attributes: { form_field_id: GT_STEP3_FIELD_TEAMS, value: String(oid) }
    });
  });
  included.push({
    type: 'FormSubmissionValue',
    attributes: { form_field_id: GT_STEP3_FIELD_FOLLOWUP, value: GT_STEP3_OPTION_FOLLOWUP }
  });

  var body = {
    data: {
      type: 'FormSubmission',
      attributes: { person_id: pco }
    },
    included: included
  };
  var res = pcoPost_('/people/v2/forms/' + GT_STEP3_FORM_ID + '/form_submissions', body);
  var id = res && res.data && res.data.id;
  if (!id) throw new Error('PCO form submit returned no id: ' + JSON.stringify(res).slice(0, 300));
  return String(id);
}

/** 10-digit US phone for form 551600 phone_number field, or ''. */
function gtStep3PhoneDigits_(phone) {
  var s = String(phone || '').trim();
  if (!s || /^n\/?a$/i.test(s) || /email/i.test(s) || !/\d/.test(s)) return '';
  var digits = s.replace(/\D/g, '');
  if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
  return digits.length === 10 ? digits : '';
}

function gtStep3Stamp_(token, gtId, submissionId) {
  var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/growth_track_people?id=eq.' + gtId, {
    method: 'patch', contentType: 'application/json',
    headers: {
      apikey: ANON_KEY, Authorization: 'Bearer ' + token,
      Prefer: 'return=minimal'
    },
    payload: JSON.stringify({
      form_551600_submission_id: String(submissionId),
      form_551600_submitted_at: new Date().toISOString()
    }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('Stamp failed: ' + res.getContentText().slice(0, 300));
}

function pcoPost_(path, body) {
  var p = PropertiesService.getScriptProperties();
  var url = /^https:\/\//.test(path) ? path : 'https://api.planningcenteronline.com' + path;
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(
        p.getProperty('PCO_APP_ID') + ':' + p.getProperty('PCO_SECRET')),
      Accept: 'application/json'
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode(), text = res.getContentText();
  if (code >= 300) throw new Error('PCO POST ' + code + ': ' + text.slice(0, 400));
  return text ? JSON.parse(text) : null;
}
