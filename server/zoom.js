// Zoom Server-to-Server OAuth + Phone call history (GET /phone/call_history).
// Zoom rules: max one month per request, only the last six months, paginated by next_page_token.

const DAY_MS = 86_400_000;
export const HISTORY_DAYS = 182;
const WINDOW_DAYS = 30;
const CACHE_MS = 60_000;

export class ZoomError extends Error {}

export const configured = () => Boolean(process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET);

const history = new Map();

let token = null;
let pendingToken = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const zoomTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function requestToken() {
  const { ZOOM_ACCOUNT_ID: accountId, ZOOM_CLIENT_ID: clientId, ZOOM_CLIENT_SECRET: clientSecret } = process.env;
  if (!accountId || !clientId || !clientSecret) {
    throw new ZoomError('Zoom credentials are missing. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET in .env.');
  }
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new ZoomError(`Zoom rejected the credentials in .env: ${body.reason || body.error || `HTTP ${res.status}`}.`);
  }
  return {
    value: body.access_token,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    apiUrl: body.api_url || 'https://api.zoom.us',
  };
}

// Tokens last ~1 hour; renew 5 minutes early and share one request between concurrent callers.
async function getToken() {
  if (token && token.expiresAt - Date.now() > 5 * 60_000) return token;
  pendingToken ??= requestToken().finally(() => {
    pendingToken = null;
  });
  token = await pendingToken;
  return token;
}

async function zoomGet(path, query) {
  let reauthenticated = false;
  for (let attempt = 0; ; attempt++) {
    const { value, apiUrl } = await getToken();
    const url = new URL(`${apiUrl}/v2${path}`);
    for (const [key, val] of Object.entries(query)) if (val) url.searchParams.set(key, val);

    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${value}` }, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new ZoomError(`Could not reach Zoom: ${error.message}`);
    }

    if (res.status === 401 && !reauthenticated) {
      reauthenticated = true;
      token = null;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(1000 * 2 ** attempt + Math.random() * 300);
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ZoomError(body.message || `Zoom API error (HTTP ${res.status}).`);
    return body;
  }
}

/** All call history records that started in [from, to), de-duplicated by call history ID. */
export async function fetchCallHistory(from, to) {
  const records = new Map();
  for (let start = from.getTime(); start < to.getTime(); start += WINDOW_DAYS * DAY_MS) {
    const end = Math.min(start + WINDOW_DAYS * DAY_MS, to.getTime());
    let nextPageToken = '';
    do {
      const body = await zoomGet('/phone/call_history', {
        from: zoomTime(start),
        to: zoomTime(end),
        page_size: '300',
        next_page_token: nextPageToken,
      });
      for (const item of body.call_history || body.call_logs || []) {
        const id = item.call_history_uuid || item.id;
        if (id) records.set(id, item);
      }
      nextPageToken = body.next_page_token || '';
    } while (nextPageToken);
  }
  return [...records.values()];
}

/**
 * Call history for a resolved range ({ from, to } dates), kept for a minute. The Zoom call log and the Dashboard both read it
 * from here, so they always count the very same records. Zoom keeps six months, so anything older is left out.
 */
export async function callHistory(range, { refresh = false } = {}) {
  const now = Date.now();
  const key = `${range.from.toISOString()}|${range.to.toISOString()}`;
  let entry = history.get(key);
  if (!entry || refresh || now - entry.at > CACHE_MS) {
    const start = Math.max(range.from.getTime(), now - HISTORY_DAYS * DAY_MS);
    const end = Math.min(range.to.getTime(), now);
    entry = { at: now, items: end > start ? await fetchCallHistory(new Date(start), new Date(end)) : [] };
    history.set(key, entry);
    if (history.size > 50) history.delete(history.keys().next().value);
  }
  return entry;
}
