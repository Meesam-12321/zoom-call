// Phone numbers (E.164 for dialing, original text kept for display), US states and lead time zones.

// Spreadsheet placeholders that mean "no value".
const EMPTY = /^(?:n\/?a|n\.a\.?|none|null|nil|-+|—|unknown|tbd|not available|not found\b.*)$/i;

/** Single-line trimmed text, or null for blanks and placeholders such as "NA" or "Not Found". */
export function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text && !EMPTY.test(text) ? text : null;
}

/** Like clean(), but keeps line breaks (notes, descriptions). */
export function cleanText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text && !EMPTY.test(text) ? text : null;
}

const US_NUMBER = /(?:\+?1[\s.-]*)?\(?([2-9]\d{2})\)?[\s.-]*([2-9]\d{2})[\s.-]*(\d{4})(?!\d)/;

/** The first US/Canada number in the text as +1XXXXXXXXXX, else an international +number, else null. */
export function toE164(value) {
  const text = clean(value);
  if (!text) return null;
  const us = US_NUMBER.exec(text);
  if (us) return `+1${us[1]}${us[2]}${us[3]}`;
  const digits = /^\+(\d[\d\s().-]{6,20}\d)/.exec(text)?.[1].replace(/\D/g, '') || '';
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

/** A number as Zoom reports it (+18135551234, which must match exactly), else read the way the importer reads numbers. */
export const asE164 = (number) => (/^\+\d{8,15}$/.test(number || '') ? number : toE164(number));

export function formatPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164 || '';
}

/** The first email address in the text ("Info@x.com (generic)" → "info@x.com"), else null. */
export function extractEmail(value) {
  const match = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i.exec(clean(value) || '');
  return match ? match[0].toLowerCase() : null;
}

export const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const STATE_BY_NAME = new Map(Object.entries(STATES).map(([code, name]) => [name.toLowerCase(), code]));

/** "Florida" / "fl" → "FL"; anything unrecognised is kept as typed. */
export function stateCode(value) {
  const text = clean(value);
  if (!text) return null;
  const upper = text.toUpperCase();
  if (STATES[upper]) return upper;
  return STATE_BY_NAME.get(text.toLowerCase().replace(/\./g, '')) || text;
}

const ET = 'America/New_York';
const CT = 'America/Chicago';
const MT = 'America/Denver';
const PT = 'America/Los_Angeles';

// The zone most of each state is in; split states are refined by area code (or city for Florida) below.
const STATE_TZ = {
  AL: CT, AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: CT, CA: PT, CO: MT, CT: ET, DE: ET, DC: ET, FL: ET,
  GA: ET, HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: CT, IN: 'America/Indiana/Indianapolis', IA: CT, KS: CT,
  KY: ET, LA: CT, ME: ET, MD: ET, MA: ET, MI: 'America/Detroit', MN: CT, MS: CT, MO: CT, MT: MT, NE: CT, NV: PT,
  NH: ET, NJ: ET, NM: MT, NY: ET, NC: ET, ND: CT, OH: ET, OK: CT, OR: PT, PA: ET, RI: ET, SC: ET, SD: CT, TN: CT,
  TX: CT, UT: MT, VT: ET, VA: ET, WA: PT, WV: ET, WI: CT, WY: MT,
};
const AREA_OVERRIDES = { 'TX:915': MT, 'TN:423': ET, 'TN:865': ET, 'KY:270': CT, 'KY:364': CT, 'IN:219': CT };
const FL_AREA_CODES = new Set(['239', '305', '321', '324', '352', '386', '407', '448', '561', '645', '656', '689', '727', '728', '754', '772', '786', '813', '850', '863', '904', '941', '954']);
// The Florida panhandle west of the Apalachicola River is on Central time.
const FL_CENTRAL_CITIES = /^(?:pensacola|panama city|fort walton beach|destin|crestview|niceville|navarre|milton|gulf breeze|pace|cantonment|defuniak springs|santa rosa beach|miramar beach|freeport|mary esther|lynn haven|callaway|mexico beach|marianna|chipley|bonifay|graceville|blountstown)\b/i;

/** Best guess of a lead's IANA time zone from its state, city and phone area code (null if unknown). */
export function guessTimeZone({ state, city, phone }) {
  const area = /^\+1(\d{3})/.exec(phone || '')?.[1];
  const code = STATES[state] ? state : FL_AREA_CODES.has(area) ? 'FL' : null;
  if (!code) return null;
  if (code === 'FL') return FL_CENTRAL_CITIES.test(String(city || '').trim()) ? CT : ET;
  return AREA_OVERRIDES[`${code}:${area}`] || STATE_TZ[code];
}
