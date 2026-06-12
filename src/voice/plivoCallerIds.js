import { config } from '../config.js';
import { normalizeUsPhone } from '../compliance.js';

const CACHE_MS = 1000 * 60 * 5;
const PAGE_SIZE = 20;
const MAX_PAGES = 10;

let cache = {
  expiresAt: 0,
  callerIds: null
};

function assertPlivoConfig() {
  if (!config.plivo.authId || !config.plivo.authToken) {
    throw new Error('Missing PLIVO_AUTH_ID or PLIVO_AUTH_TOKEN');
  }
}

function authHeader() {
  const token = Buffer.from(`${config.plivo.authId}:${config.plivo.authToken}`).toString('base64');
  return `Basic ${token}`;
}

async function fetchPage(offset) {
  const url = new URL(`/v1/Account/${config.plivo.authId}/VerifiedCallerId/`, config.plivo.apiBaseUrl);
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('offset', String(offset));

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: authHeader()
    }
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(result.error || result.message || `Plivo verified caller ID lookup failed with ${response.status}`);
  }
  return result;
}

export async function fetchPlivoVerifiedCallerIds(options = {}) {
  assertPlivoConfig();
  if (!options.refresh && cache.callerIds && cache.expiresAt > Date.now()) {
    return { callerIds: cache.callerIds, source: 'plivo-cache' };
  }

  const callerIds = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(page * PAGE_SIZE);
    const records = result.objects || result.results || [];
    callerIds.push(...records.map((record) => {
      const phoneNumber = normalizeUsPhone(record.phone_number || record.number);
      if (!phoneNumber) return null;
      return {
        phoneNumber,
        alias: String(record.alias || '').trim(),
        country: String(record.country || '').trim()
      };
    }).filter(Boolean));

    const totalCount = Number(result.meta?.total_count || callerIds.length);
    if (records.length < PAGE_SIZE || callerIds.length >= totalCount) break;
  }

  const unique = callerIds.filter((callerId, index, records) => (
    records.findIndex((item) => item.phoneNumber === callerId.phoneNumber) === index
  ));
  cache = {
    expiresAt: Date.now() + CACHE_MS,
    callerIds: unique
  };
  return { callerIds: unique, source: 'plivo' };
}

export async function assertPlivoVerifiedCallerId(phoneNumber) {
  const normalized = normalizeUsPhone(phoneNumber);
  if (!normalized) {
    throw new Error('Enter a valid US caller ID number');
  }
  if (config.voiceProvider !== 'plivo') return normalized;

  const result = await fetchPlivoVerifiedCallerIds();
  if (!result.callerIds.some((callerId) => callerId.phoneNumber === normalized)) {
    throw new Error(`${normalized} is not a verified caller ID in this Plivo account`);
  }
  return normalized;
}
