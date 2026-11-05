// Field lists, pipeline stages and default call outcomes, shared by the server and (via /api/meta) the browser.

// Company fields mirror the HV template's "Company Information" sheet: same columns, names and order.
// Time zone and lead score are CRM-only.
export const COMPANY_FIELDS = [
  ['name', 'Company Name'],
  ['department', 'PT Department'],
  ['industry', 'Industry'],
  ['status', 'Company Status'],
  ['category', 'Company Category'],
  ['revenue_range', 'Revenue ($) Range'],
  ['revenue', 'Revenue ($)'],
  ['employee_range', 'Employees Range'],
  ['website', 'Website'],
  ['region', 'Region'],
  ['state', 'Location/Province/State'],
  ['address', 'Address'],
  ['linkedin_url', 'LinkedIn Company Profile URL'],
  ['hq_phone', 'Company HQ Number'],
  ['date_founded', 'Date Founded'],
  ['about', 'About Company'],
  ['area', 'Florida Region'],
  ['city', 'City'],
  ['email', 'Store Email'],
  ['opening_hours', 'Opening Hours'],
  ['facebook_url', 'Facebook Page'],
  ['instagram_url', 'Instagram'],
  ['priority', 'Priority'],
  ['evidence_notes', 'Evidence & Additional Notes'],
  ['key_people', 'Owners / Key People'],
  ['contacts_listed', 'Contacts Listed'],
  ['source_urls', 'Research Source URLs'],
  ['time_zone', 'Time zone'],
  ['lead_score', 'Lead score'],
];

// Contact fields mirror the "Contact Information" sheet. Its outreach-tracking columns (response, follow-ups…)
// are kept with the contact as extra info; the CRM now logs calls and outcomes itself.
export const CONTACT_FIELDS = [
  ['first_name', 'First Name'],
  ['middle_name', 'Middle Name'],
  ['last_name', 'Last Name'],
  ['job_title', 'Job Title'],
  ['department', 'Department'],
  ['management_level', 'Management Level'],
  ['email', 'Email'],
  ['employment_status', 'Employment Status'],
  ['mobile', 'Mobile'],
  ['direct_line', 'Direct'],
  ['linkedin_url', 'LinkedIn Profile'],
  ['current_address', 'Current Address'],
  ['location', 'Location'],
  ['email_type', 'Email Type'],
  ['notes', 'Research / First-Call Note'],
  ['source_urls', 'Source URLs'],
  ['role_type', 'Role type'],
  ['do_not_call', 'Do Not Call'],
];

export const ROLE_TYPES = [
  ['decision_maker', 'Decision maker'],
  ['gatekeeper', 'Gatekeeper'],
  ['other', 'Other'],
];

export const STAGES = [
  ['new', 'New'],
  ['attempted', 'Attempted'],
  ['connected', 'Connected'],
  ['interested', 'Interested'],
  ['meeting_booked', 'Meeting booked'],
  ['demo_done', 'Demo done'],
  ['proposal_sent', 'Proposal sent'],
  ['won', 'Won'],
  ['lost', 'Lost'],
  ['nurture', 'Nurture'],
];

export const LOST_REASONS = ['Price', 'Already has a system', 'Not decision maker', 'No need', 'Other'];

export const TASK_TYPES = [
  ['call', 'Call'],
  ['email', 'Email'],
  ['linkedin', 'LinkedIn'],
  ['other', 'Other'],
];

// What a call outcome does after the call. Admins pick one per outcome.
export const DISPOSITION_ACTIONS = [
  ['retry', 'Retry the call after N days'],
  ['callback', 'Callback at the date and time entered'],
  ['positive', 'Follow-up task; stage Interested or Meeting booked'],
  ['nurture', 'Move to Nurture; follow up after N days'],
  ['lost', 'Mark lost and ask for the reason'],
  ['invalid_number', 'Flag the number as invalid'],
  ['dnc', 'Set Do Not Call and block dialing'],
  ['none', 'Nothing automatic'],
];

// From the requirements: outcome → counts as connected → default next action.
export const DEFAULT_DISPOSITIONS = [
  { key: 'no_answer', label: 'No answer', connected: 0, action: 'retry', retry_days: 1, task_title: 'Retry call' },
  { key: 'voicemail', label: 'Voicemail left', connected: 0, action: 'retry', retry_days: 2, task_title: 'Retry call' },
  { key: 'hung_up', label: 'Hung up', connected: 0, action: 'retry', retry_days: 2, task_title: 'Retry call' },
  { key: 'gatekeeper', label: 'Gatekeeper', connected: 1, action: 'retry', retry_days: 2, task_title: 'Retry call and ask for the decision maker' },
  { key: 'conversation', label: 'Had a conversation', connected: 1, action: 'none' },
  { key: 'callback', label: 'Call back later', connected: 1, action: 'callback', task_title: 'Callback' },
  { key: 'positive', label: 'Positive (meeting or inquiry)', connected: 1, action: 'positive', task_title: 'Book the meeting and send a follow-up email' },
  { key: 'prospect', label: 'Prospect (future interest or referral)', connected: 1, action: 'nurture', retry_days: 30, task_title: 'Nurture follow-up call' },
  { key: 'negative', label: 'Negative (not interested)', connected: 1, action: 'lost' },
  { key: 'wrong_number', label: 'Wrong number', connected: 0, action: 'invalid_number' },
  { key: 'do_not_call', label: 'Do not call', connected: 1, action: 'dnc' },
];
