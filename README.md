# Zoom Call Logs

A small local web page that shows your Zoom Phone call history:

- **Calls per day**: chart plus a daily table (calls, connected, talk time, average duration)
- **Every call**: time, direction, number, result and duration, grouped by day
- **Averages**: calls per day, average call duration, total talk time
- **Any single day**: Today, Yesterday, Day before yesterday or any date you pick. Use ‹ › to step one day at a time.

The address bar keeps the current view, so you can bookmark it, for example `/?period=yesterday` or `/?date=2026-10-29`.

Data is read live from Zoom. Nothing is stored in a database.

## Run it

Needs Node.js 20.12 or newer.

```bash
npm install
npm start
```

Then open http://localhost:4000. Use `npm run dev` to auto-restart the server while editing, and `npm test` to run the tests.

## Zoom setup

The credentials go in `.env` (see `.env.example`). They come from a **Server-to-Server OAuth** app in the Zoom App Marketplace. The app needs the scope `phone:read:list_call_logs:admin` (or the classic `phone:read:admin`).

## How the numbers are calculated

| Number | Definition |
|---|---|
| Connected | Zoom says the call was answered and, for outgoing calls, it lasted at least 10 seconds after that (see below) |
| Total talk time | Sum of the durations of connected calls |
| Average call duration | Total talk time ÷ connected calls |
| Average calls per day | All calls ÷ days in the selected period (days with no calls count as 0) |

Days are calendar days in the timezone picked at the top of the page.

### Why short outgoing calls are "Not connected"

For outgoing calls Zoom reports **connected** whenever something answers the line: a person, but also voicemail, a phone menu or a "number not in service" recording. Zoom has no field that tells these apart, so the app goes by call length: an outgoing call that ends less than 10 seconds after it was answered counts as **Not connected**. Hover a call's result to see how long it rang first (voicemail usually answers after 20–30 seconds of ringing).

To change the cutoff, set `MIN_CONNECTED_SECONDS` in `.env` and restart the server. `0` uses Zoom's result as is. A call where you listened to a voicemail greeting for longer, or left a message, still counts as connected.

## Good to know

- Zoom only provides the **last 6 months** of call history.
- Results are cached for 60 seconds. **Refresh** fetches fresh data from Zoom.
- The server only listens on this computer (`127.0.0.1`). Call data is not reachable from your network.
