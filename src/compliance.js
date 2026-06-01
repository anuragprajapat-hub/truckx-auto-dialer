import { config } from './config.js';

function parseClock(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function localClockMinutes(timeZone, date = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date);
  }

  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

export function normalizeUsPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(phone || '').startsWith('+1') && digits.length === 11) return `+${digits}`;
  return '';
}

export function isCallableStatus(status) {
  return config.compliance.callableStatuses.includes(String(status || '').toLowerCase());
}

export function evaluateLeadForDial(lead, campaign, context = {}) {
  const phone = normalizeUsPhone(lead.phone);
  if (!phone) {
    return { allowed: false, reason: 'Invalid or non-US phone number' };
  }

  if (context.dncNumbers?.has(phone)) {
    return { allowed: false, reason: 'Number is on global DNC list' };
  }

  if (lead.doNotCall || lead.status === 'do_not_call') {
    return { allowed: false, reason: 'Lead is marked do not call' };
  }

  if (!lead.consent) {
    return { allowed: false, reason: 'Missing consent flag' };
  }

  if (!isCallableStatus(lead.status)) {
    return { allowed: false, reason: `Lead status is not callable: ${lead.status || 'blank'}` };
  }

  if ((lead.attempts || 0) >= config.compliance.maxAttemptsPerLead) {
    return { allowed: false, reason: 'Max attempt limit reached' };
  }

  const timeZone = lead.timeZone || 'America/New_York';
  const start = parseClock(campaign.callWindowStart || config.compliance.defaultCallWindowStart);
  const end = parseClock(campaign.callWindowEnd || config.compliance.defaultCallWindowEnd);
  const now = localClockMinutes(timeZone);

  if (now < start || now >= end) {
    return { allowed: false, reason: `Outside local call window in ${timeZone}` };
  }

  return { allowed: true, phone, reason: 'Allowed' };
}
