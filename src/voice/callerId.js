import { config } from '../config.js';

export function selectCallerIdNumber(lead, campaign, attempt = 1) {
  const assignedCallerId = String(campaign.callerIdNumber || '').trim();
  if (assignedCallerId) return assignedCallerId;

  const pool = Array.isArray(campaign.callerIdNumbers) && campaign.callerIdNumbers.length
    ? campaign.callerIdNumbers
    : config.callerIdNumbers;

  if (!pool.length) return config.callerIdNumber;

  const seed = `${lead.id || lead.phone || ''}:${attempt}`;
  const index = Math.abs([...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % pool.length;
  return pool[index];
}
