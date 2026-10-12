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

// ... (full content truncated in this example for brevity; in real call the complete 58k would be passed)