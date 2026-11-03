// Field lists, pipeline stages and default call outcomes, shared by the server and (via /api/meta) the browser.

export const COMPANY_FIELDS = [
  ['name', 'Company name'],
  ['industry', 'Industry'],
  ['status', 'Status'],
  ['category', 'Category (public/private)'],
  ['revenue_range', 'Revenue range'],
  ['employee_range', 'Employee range'],
  ['website', 'Website'],
  ['region', 'Region'],
  ['state', 'State'],
  ['city', 'City'],
  ['address', 'Address'],
  ['linkedin_url', 'LinkedIn URL'],
  ['hq_phone', 'HQ phone'],
  ['email', 'Email'],
  ['date_founded', 'Date founded'],
  ['about', 'About'],
  ['time_zone', 'Time zone'],
  ['lead_score', 'Lead score'],
  ['priority', 'Priority'],
];

export const CONTACT_FIELDS = [
  ['first_name', 'First name'],
  ['middle_name', 'Middle name'],
  ['last_name', 'Last name'],
  ['job_title', 'Job title'],
  ['department', 'Department'],
  ['email', 'Email'],
  ['mobile', 'Mobile'],
  ['direct_line', 'Direct line'],
  ['linkedin_url', 'LinkedIn URL'],
  ['location', 'Location'],
  ['role_type', 'Role type'],
  ['do_not_call', 'Do Not Call'],
  ['notes', 'Notes'],
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
];

// From the requirements: outcome → counts as connected → default next action.
export const DEFAULT_DISPOSITIONS = [
  { key: 'no_answer', label: 'No answer', connected: 0, action: 'retry', retry_days: 1, task_title: 'Retry call' },
  { key: 'voicemail', label: 'Voicemail left', connected: 0, action: 'retry', retry_days: 2, task_title: 'Retry call' },
  { key: 'gatekeeper', label: 'Gatekeeper', connected: 1, action: 'retry', retry_days: 2, task_title: 'Retry call and ask for the decision maker' },
  { key: 'callback', label: 'Call back later', connected: 1, action: 'callback', task_title: 'Callback' },
  { key: 'positive', label: 'Positive (meeting or inquiry)', connected: 1, action: 'positive', task_title: 'Book the meeting and send a follow-up email' },
  { key: 'prospect', label: 'Prospect (future interest or referral)', connected: 1, action: 'nurture', retry_days: 30, task_title: 'Nurture follow-up call' },
  { key: 'negative', label: 'Negative (not interested)', connected: 1, action: 'lost' },
  { key: 'wrong_number', label: 'Wrong number', connected: 0, action: 'invalid_number' },
  { key: 'do_not_call', label: 'Do not call', connected: 1, action: 'dnc' },
];
