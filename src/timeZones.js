export const US_TIME_ZONE_LABELS = ['EST', 'CST', 'MST', 'PST'];

const TIME_ZONE_MAP = {
  EST: 'America/New_York',
  EDT: 'America/New_York',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles'
};

const IANA_LABEL_MAP = {
  'America/New_York': 'EST',
  'America/Chicago': 'CST',
  'America/Denver': 'MST',
  'America/Phoenix': 'MST',
  'America/Los_Angeles': 'PST'
};

export function normalizeTimeZone(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'America/New_York';
  const upper = raw.toUpperCase();
  return TIME_ZONE_MAP[upper] || raw;
}

export function displayTimeZone(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'EST';
  const upper = raw.toUpperCase();
  if (TIME_ZONE_MAP[upper]) return upper.replace('EDT', 'EST').replace('CDT', 'CST').replace('MDT', 'MST').replace('PDT', 'PST');
  return IANA_LABEL_MAP[raw] || raw;
}

export function campaignTimeZoneTarget(campaign) {
  const target = String(campaign?.timeZoneTarget || 'ALL').trim().toUpperCase();
  return US_TIME_ZONE_LABELS.includes(target) ? target : 'ALL';
}

export function leadTimeZoneLabel(lead) {
  return displayTimeZone(lead?.timeZoneLabel || lead?.timeZone || '');
}

export function matchesCampaignTimeZone(lead, campaign) {
  const target = campaignTimeZoneTarget(campaign);
  if (target === 'ALL') return true;
  return leadTimeZoneLabel(lead).toUpperCase() === target;
}
