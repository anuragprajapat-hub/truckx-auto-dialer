import { config } from './config.js';
import { campaignTimeZoneTarget, matchesCampaignTimeZone } from './timeZones.js';

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

function campaignLeadStatusFilters(campaign) {
  return Array.isArray(campaign?.leadStatusFilters)
    ? campaign.leadStatusFilters.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
    : [];
}

export function matchesCampaignLeadStatus(lead, campaign) {
  const filters = campaignLeadStatusFilters(campaign);
  if (!filters.length) return true;
  return filters.includes(String(lead?.status || '').trim().toLowerCase());
}

export function evaluateLeadForDial(lead, campaign, context = {}) {
  const phone = normalizeUsPhone(lead.phone);
  const leadStatus = String(lead.status || '').trim().toLowerCase();
  if (!phone) {
    return { allowed: false, reason: 'Invalid or non-US phone number' };
  }

  if (context.dncNumbers?.has(phone)) {
    return { allowed: false, reason: 'Number is on global DNC list' };
  }

  if (lead.doNotCall || leadStatus === 'do_not_call') {
    return { allowed: false, reason: 'Lead is marked do not call' };
  }

  if (leadStatus === 'provider_error') {
    return { allowed: false, reason: `Provider error: ${lead.lastProviderError || 'Call provider rejected the request'}` };
  }

  if (!matchesCampaignTimeZone(lead, campaign)) {
    return { allowed: false, reason: `Not in ${campaignTimeZoneTarget(campaign)} campaign` };
  }

  if (!matchesCampaignLeadStatus(lead, campaign)) {
    return { allowed: false, reason: 'Lead status does not match the selected filter' };
  }

  if (
    !campaignLeadStatusFilters(campaign).length
    && config.compliance.callableStatuses.length
    && !isCallableStatus(lead.status)
  ) {
    return { allowed: false, reason: 'Lead status is outside the default dialing queue' };
  }

  if ((lead.attempts || 0) >= config.compliance.maxAttemptsPerLead) {
    return { allowed: false, reason: 'Max attempt limit reached' };
  }

  return { allowed: true, phone, reason: 'Allowed' };
}
