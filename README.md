# Cold-Calling CRM

A CRM for B2B cold calling with Zoom Phone. Leads come in from Excel, callers dial with one click through Zoom, every call ends with a required outcome, and follow-up tasks, the pipeline and the dashboard update by themselves.

This is the **MVP** phase of the requirements document (Nov 3, 2026).

## What it does

| Area | What you get |
|---|---|
| Leads | Companies and contacts with the HV template's fields. Search and filter by state, stage, last outcome, last called, priority, owner and Do Not Call. Export any list to Excel. |
| Import | `.xlsx` or `.csv`, with a column-mapping screen. The HV template (Company Information + Contact Information sheets) imports with one click; other layouts can be saved as presets. Duplicates (same phone, email or company name) are listed so you can skip, merge or create each one. A validation report shows missing phones, invalid emails and unmatched company names, and "NA" counts as empty. |
| Calling | A **Call** button opens Zoom on the number. The outcome window opens straight away and cannot be closed until an outcome is saved, and the next call is blocked until then. The window shows the contact, their local time, the research note, the script, open tasks and past calls. Zoom's record of the call (duration, answered, Zoom call ID) is attached within about a minute. |
| Outcomes | No answer, Voicemail left, Gatekeeper, Call back later, Positive, Prospect, Negative, Wrong number and Do not call, each with "counts as connected" and a next action. Admins can edit the list. |
| Pipeline | New → Attempted → Connected → Interested → Meeting booked → Demo done → Proposal sent → Won / Lost, plus Nurture. Shown as a drag-and-drop board and a list. Outcomes move leads forward automatically, and moving a lead to Lost asks for the reason. |
| Tasks | Created automatically from outcomes. The **Today** page lists overdue tasks, tasks and callbacks due today, and leads never called. Callbacks get a reminder 10 minutes before. Each lead has an attempt counter, with a warning after 8 attempts (configurable). |
| Call lists | Group leads into campaigns, such as "Florida flooring – batch 1", and go through them with the dialer: call, save the outcome, and the next lead loads. |
| Dashboard | Calls, calls picked up, connect rate, talk time, average call duration, conversations, outcome breakdown, meetings and meeting rate, daily target progress, and pipeline per stage. Filter by period, caller and call list, and export to Excel. |
| Compliance | Do Not Call on contacts and companies, which blocks dialing. The "Do not call" outcome sets the flag permanently, and only an admin can clear it. There is a per-state recording-consent setting, user roles, sign-in and an activity log of every change. |

## First run

```bash
npm install
npm start
```

1. Open http://localhost:4000 on this computer and create the **admin** account. No code is needed on this computer; from another device, use the setup code printed in the terminal.
2. **Settings → Users → Add user**: add the cold caller with the role **Caller** and their daily targets.
3. **Import**: upload the HV workbook, check the report and press **Import**. Assign the leads to the caller and keep the call-list name.
4. The caller signs in, opens **Call lists → Start dialing**, and works through the list.

Callers see only the leads assigned to them. Admins see everything.

## Letting the caller in from another computer

By default the server only listens on this computer (`127.0.0.1`). Pick one:

- **Same office network:** add `HOST=0.0.0.0` to `.env` and restart. Allow Node.js through Windows Firewall when asked. The caller then opens `http://<this computer's IP>:4000`.
- **Anywhere else (for example, a caller in another country):** run the app on a small cloud server behind HTTPS. Copy `.env` there and keep `data/` on a persistent disk.

Never expose it to the internet without HTTPS.

## Zoom

- **Dialing:** the Call button uses a `zoomphonecall://` link. It opens the Zoom Workplace desktop app, which dials from your Zoom Phone number, so the caller ID is your US Zoom number. If the link does not open Zoom, go to Settings → Calling rules → "How the Call button dials", choose **Default phone app** (`tel:`), and make Zoom the default calling app.
- **Logging:** the existing Server-to-Server OAuth app (scope `phone:read:list_call_logs:admin`) is enough. Every minute the server reads Zoom's call history and attaches each record to the CRM call that dialed it. A match is the same number, starting between a minute before and 10 minutes after the click.
- **Embeddable dialer:** no extra Zoom plan or API access is needed for this MVP. Zoom's embeddable dialer (Smart Embed) is an option later, for calling inside the browser and detecting hang-up instantly. It needs a Marketplace app and an HTTPS domain.

## How the dashboard numbers are calculated

| Number | Definition |
|---|---|
| Total calls | Calls dialed from the CRM |
| Calls picked up | Calls whose outcome counts as connected, meaning a person answered |
| Connect rate | Picked up ÷ total calls |
| Total talk time | Sum of Zoom call durations |
| Average call duration | Zoom duration of connected calls ÷ connected calls that have Zoom data |
| Conversations | Connected calls longer than 60 seconds (configurable) |
| Meetings booked / meeting rate | Positive outcomes with "meeting booked" / meetings ÷ conversations |

Days and "today" use the business time zone (Settings → Calling rules, default US Eastern). Callback times are entered in the **lead's** local time.

## The Zoom call log page

The original call-log viewer is still under **Zoom call log** (`/calls.html`). It lists every Zoom Phone call by day, including calls made outside the CRM.

On that page, Zoom can't tell a person from voicemail or a phone menu, so outgoing calls under 10 seconds count as "Not connected". Change this with `MIN_CONNECTED_SECONDS` in `.env`; `0` uses Zoom's result as is.

## Data, backups and security

- **Storage:** all CRM data is in `data/crm.db` (SQLite, built into Node). Back it up by copying that file while the server is stopped. It is not in git.
- **Accounts:** passwords are hashed with scrypt. Sessions use HTTP-only cookies and last 30 days. Sign-in attempts are rate limited.
- **Browser protections:** cross-site requests are blocked and pages run under a strict Content Security Policy.
- **Encryption:** the app does not encrypt the database file itself. Keep it on an encrypted disk (BitLocker, FileVault, or an encrypted cloud volume) and serve it over HTTPS.

## Not built yet

- **Recording links.** Recording is off in this Zoom account, so there was nothing to test against. The call history shows "Recorded in Zoom" when Zoom reports a recording. Florida requires every party's consent to record. The per-state setting only reminds the caller on the call screen; the recording itself and any notice are Zoom settings.
- **V2:**
  - Calling: power-dial queue (callbacks first, then score), calling-hours guard, matching calls dialed outside the CRM.
  - Follow-up: cadences, post-call email templates, meeting booking.
  - Data: importing past outreach from the HV columns (kept as "extra info" for now).
  - Reports: funnel, best-time heatmap, leaderboard, lost-reason report.
- **V3:** AI transcripts and summaries, lead scoring and voicemail drop.

## Development

`npm run dev` restarts the server when code changes. `npm test` runs the tests.

- `server/`: the Express API. `app.js` assembles it. `calling.js` handles calls, outcomes, tasks and lists, `leads.js` companies, contacts and the pipeline, `importer.js` Excel import, `sync.js` the Zoom sync, and `analytics.js` the dashboard.
- `public/`: the browser app (plain JavaScript modules, no build step).
