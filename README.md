# Cold-Calling CRM

A CRM for B2B cold calling with Zoom Phone. Leads come in from Excel, callers dial with one click through Zoom, every call ends with a required outcome, and follow-up tasks, the pipeline and the dashboard update by themselves.

This is the **MVP** phase of the requirements document (Nov 3, 2026).

## What it does

| Area | What you get |
|---|---|
| Leads | Companies and contacts with the HV template's own columns, names and order ("Company Information" and "Contact Information"), including Florida Region, Opening Hours, Owners / Key People, Evidence & Additional Notes and the research links. Search and filter by Florida Region, state, stage, last outcome, last called, priority, owner and Do Not Call. Export any list to Excel in the same sheet layout. |
| Import | `.xlsx` or `.csv`, with a column-mapping screen. The HV template (Company Information + Contact Information sheets) imports with one click; other layouts can be saved as presets. **Duplicates**: a row that repeats a lead already in the CRM, whether from a file imported earlier or added by hand, is flagged as a potential duplicate instead of being added again. A company matches on its name or HQ phone number; a contact on its email, phone number, or name at the same company. The review lists every field that matched (with the shared value) and where the existing lead came from: the file it was imported from, the date, and its call lists. Flagged rows are merged (only empty fields are filled) or, when just an email or number matches under a different name, skipped. They are never created a second time unless you choose **Create anyway**, and the existing lead's History records each later file that repeated it. A validation report shows missing phones, invalid emails and unmatched company names, and "NA" counts as empty. There is also a command-line import (below). |
| Sync | Sheets you import are remembered in Chrome, Edge or Opera (on localhost or HTTPS). **Sync now** reads the latest version of the file and shows what will change before anything is saved. New leads are added and existing leads only get their empty fields filled in. |
| Navigation | **Ctrl+K** or **/** searches leads, pages and actions from anywhere. The sun/moon button switches between the light and dark themes. |
| Calling | A **Call** button opens Zoom on the number. The outcome window opens straight away and cannot be closed until an outcome is saved, and the next call is blocked until then. The window shows the contact, their local time, the research note, the script, open tasks and past calls. Zoom's record of the call (duration, answered, Zoom call ID) is attached within about a minute. **Edit name and email** in that window (and on the dialer) fixes the contact's details while you are on the call, or the store's when nobody is on file: the script greets them by the new name, and every call log and the History show the change. |
| Calls made by hand | Calls dialed straight in Zoom show on the call list as "Called in Zoom, no note". **Log call** records one with a one-click template, a note and a reminder, and can also be used from the dialer, lead pages and the Zoom call log. Reminders can be snoozed from the call list, the Today page or the reminder pop-up. |
| Outcomes | No answer, Voicemail left, Hung up, Gatekeeper, Had a conversation, Call back later, Positive, Prospect, Negative, Wrong number and Do not call, each with "counts as connected" and a next action. Hung up is "not connected" and retries in 2 days. Admins can edit the list. |
| Pipeline | New → Attempted → Connected → Interested → Meeting booked → Demo done → Proposal sent → Won / Lost, plus Nurture. Shown as a drag-and-drop board and a list. Outcomes move leads forward automatically, and moving a lead to Lost asks for the reason. |
| Tasks | Created automatically from outcomes. The **Today** page lists overdue tasks, tasks and callbacks due today, and leads never called. Callbacks get a reminder 10 minutes before. Each lead has an attempt counter, with a warning after 8 attempts (configurable). |
| Call lists | Group leads into campaigns, such as "Florida flooring – batch 1", and go through them with the dialer: call, save the outcome, and the next lead loads. Admins can make a list straight from a sheet with **New list from Excel**: drop an Excel or CSV file, see what it holds (new leads, leads already in the CRM, problems), name the list and create it, and the list opens. Leads already in the CRM go on the list with only their empty fields filled in, and nobody is created twice. Every row has **Edit** for the lead's name, job title, email, phone numbers and store, and a "No phone number" view gathers the rows that need one. |
| Email | The **Inbox** tab shows the Gmail account's full mailbox by conversation (Inbox, Sent, All mail, Gmail search), and you can read, reply and send from it. Every lead has an **Email** button, its page lists its conversations, and sent emails appear in its history. Admins only. |
| Dashboard | Connected calls out of all calls, connection rate, talk time, average call duration, conversations, outcome breakdown, meetings and meeting rate, daily target progress, and pipeline per stage. Call numbers come from Zoom and match the Zoom call log. Filter by period, caller and call list, and export to Excel. |
| Compliance | Do Not Call on contacts and companies, which blocks dialing. The "Do not call" outcome sets the flag permanently, and only an admin can clear it. There is a per-state recording-consent setting, user roles, sign-in and an activity log of every change. |

## First run

```bash
npm install
npm start
```

1. Open http://localhost:4000 on this computer and create the **admin** account.
2. **Import**: upload the HV workbook, check the report and press **Import**. Keep the call-list name.
3. **Settings → Users → Add user**: add the cold caller with the role **Caller** and their daily targets. Leave **Give this caller the leads nobody owns yet** ticked so they get the imported leads.
4. The caller signs in, opens **Call lists → Start dialing**, and works through the list.

Callers see only the leads assigned to them. Admins see everything.

### Importing from the command line

```bash
npm run import -- "path/to/workbook.xlsx" --list "Florida flooring – batch 1" [--owner caller@example.com]
```

This uses the same mapping and checks as the Import page (the HV template is recognised automatically) and prints what was created. Without `--owner` the leads stay unassigned until you give them to a caller. Importing the same file again creates nothing new: rows already in the CRM are flagged as duplicates, and the command prints each one with the fields that matched and the file the existing lead came from.

## Letting the caller in from another computer

By default the server only listens on this computer (`127.0.0.1`). Pick one:

- **Same office network:** add `HOST=0.0.0.0` to `.env` and restart. Allow Node.js through Windows Firewall when asked. The caller then opens `http://<this computer's IP>:4000`.
- **Anywhere else (for example, a caller in another country):** run the app on a small cloud server behind HTTPS. Copy `.env` there and keep `data/` on a persistent disk. Create the admin account as soon as it is up: while no account exists, whoever opens the page first can create it, and a disk that gets wiped puts it back in that state.

Never expose it to the internet without HTTPS.

## Zoom

- **Dialing:** the Call button uses a `zoomphonecall://` link. It opens the Zoom Workplace desktop app, which dials from your Zoom Phone number, so the caller ID is your US Zoom number. If the link does not open Zoom, go to Settings → Calling rules → "How the Call button dials", choose **Default phone app** (`tel:`), and make Zoom the default calling app.
- **Logging:** the existing Server-to-Server OAuth app (scope `phone:read:list_call_logs:admin`) is enough. Every minute the server reads Zoom's call history and attaches each record to the CRM call that dialed it. A match is the same number, starting between a minute before and 10 minutes after the click.
- **Embeddable dialer:** no extra Zoom plan or API access is needed for this MVP. Zoom's embeddable dialer (Smart Embed) is an option later, for calling inside the browser and detecting hang-up instantly. It needs a Marketplace app and an HTTPS domain.

## Email

Add the account to `.env` and restart: `GMAIL_USER` is the address and `GMAIL_APP_PASSWORD` is an [app password](https://myaccount.google.com/apppasswords) created on that same account. Both Gmail and Google Workspace work, and the password can be pasted with or without its spaces.

- **Who can use it:** admins only, because it is the whole mailbox. Callers see no Inbox tab and no Email buttons.
- **Live from Gmail:** nothing is copied into the CRM's database except a note in the lead's history (who, subject). Email sent from the CRM lands in Gmail's Sent folder, and replies stay in the same conversation.
- **Read state:** opening a conversation marks it read in Gmail too. Just listing the mailbox changes nothing.
- **Do Not Call:** emailing a lead marked Do Not Call asks for confirmation first, and the history notes that it was sent anyway.
- **Safety:** anyone can send HTML to this mailbox, so each email is shown in a sandboxed frame where scripts and forms cannot run. Remote images stay off until you choose **Show images**, because loading them tells the sender you opened the email. Attachments are always downloaded, never opened in the page.
- **The app password:** it can read and send all of this account's email, so it stays in `.env` (not in git). Anyone with that file has that access. To cut it off, revoke the password at the link above.

## How the dashboard numbers are calculated

The call numbers come from Zoom's call history, the same records and the same rules as the **Zoom call log** page, so for the same period and time zone the two pages always show the same figures. That includes calls you dialed in Zoom itself, not only with the CRM's Call button. Outcomes and meetings come from what callers saved in the CRM, so a call dialed outside the CRM counts as a call but has no outcome yet.

| Number | Definition |
|---|---|
| Total calls | Every Zoom Phone call in the period, outgoing and incoming |
| Connected calls | Zoom says the line was answered and, for outgoing calls, it lasted at least 10 seconds (see below) |
| Connection rate | Connected ÷ total calls |
| Total talk time | Sum of the durations of connected calls |
| Average call duration | Total talk time ÷ connected calls |
| Conversations | Connected calls longer than 60 seconds (configurable) |
| Meetings booked / meeting rate | Positive outcomes saved with "meeting booked" / meetings ÷ conversations |
| Outcomes | The outcome saved for each call. Calls with none show as "Outcome not saved yet" |

- **Caller filter:** a call belongs to the caller who dialed it from the CRM, or else to the caller whose CRM email is the Zoom user's email. Callers only ever see their own calls. Daily targets work the same way, so keep each caller's CRM email the same as their Zoom email.
- **Call list filter:** only calls to numbers of leads in that list.
- **No Zoom:** if Zoom is not set up or cannot be reached, the Dashboard says so and counts only the calls dialed from the CRM, with "connected" taken from the outcome the caller saved.

Days and "today" use the business time zone (Settings → Calling rules, default US Eastern). Callback times are entered in the **lead's** local time.

## The Zoom call log page

**Zoom call log** (a tab inside **Reports**) lists every Zoom Phone call by day, straight from Zoom, including calls made outside the CRM. It shows totals, a calls-per-day chart and a daily summary for any day or range, and a call to a lead's number links to that lead. The old `/calls.html` address opens this page.

Zoom can't tell a person from voicemail or a phone menu, so outgoing calls under 10 seconds count as "Not connected", on this page and on the Dashboard. Change this with `MIN_CONNECTED_SECONDS` in `.env`; `0` uses Zoom's result as is. The first card reads "Connected calls: 70 of 103", with the connection rate and the number not connected beneath it.

## Data, backups and security

- **Storage:** all CRM data is in `data/crm.db` (SQLite, built into Node). Back it up by copying that file while the server is stopped. It is not in git.
- **Accounts:** passwords are hashed with scrypt. Sessions use HTTP-only cookies and last 30 days. Sign-in attempts are rate limited.
- **Browser protections:** cross-site requests are blocked and pages run under a strict Content Security Policy.
- **Encryption:** the app does not encrypt the database file itself. Keep it on an encrypted disk (BitLocker, FileVault, or an encrypted cloud volume) and serve it over HTTPS.

## Not built yet

- **Recording links.** Recording is off in this Zoom account, so there was nothing to test against. The call history shows "Recorded in Zoom" when Zoom reports a recording. Florida requires every party's consent to record. The per-state setting only reminds the caller on the call screen; the recording itself and any notice are Zoom settings.
- **Email:** sending attachments, signatures, formatted (HTML) messages, and Spam and Trash folders. Sent email is plain text.
- **V2:**
  - Calling: power-dial queue (callbacks first, then score), calling-hours guard, matching calls dialed outside the CRM.
  - Follow-up: cadences, post-call email templates, meeting booking.
  - Data: importing past outreach from the HV columns (kept as "extra info" for now).
  - Reports: funnel, best-time heatmap, leaderboard, lost-reason report.
- **V3:** AI transcripts and summaries, lead scoring and voicemail drop.

## Development

`npm run dev` restarts the server when code changes. `npm test` runs the tests.

- `server/`: the Express API. `app.js` assembles it. `fields.js` lists the lead fields (the HV sheet's columns), `calling.js` handles calls, outcomes, tasks and lists, `leads.js` companies, contacts and the pipeline, `importer.js` Excel import, `duplicates.js` the duplicate matching behind it, `sync.js` the Zoom sync, `zoomlog.js` the Zoom call log, `gmail.js` and `mail.js` email, and `analytics.js` the dashboard.
- `public/`: the browser app (plain JavaScript modules, no build step). Each page is in `public/js/pages/`. `veloq.css` holds the Veloq brand tokens for the light and dark themes.
- `scripts/import.js`: the command-line import.
