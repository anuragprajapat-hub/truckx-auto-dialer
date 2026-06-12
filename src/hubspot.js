import { config } from './config.js';
import { displayTimeZone, normalizeTimeZone } from './timeZones.js';

const HUBSPOT_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const HUBSPOT_MAX_RETRIES = 4;
const STATUS_OPTION_CACHE_MS = 1000 * 60 * 10;
const CONTACT_PAGE_SIZE = 200;

let leadStatusOptionsCache = {
  expiresAt: 0,
  options: null
};

function hasHubSpotToken() {
  return Boolean(config.hubspot.privateAppToken);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response, attempt) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
    const retryAt = new Date(retryAfter).getTime();
    if (Number.isFinite(retryAt)) return Math.max(1000, retryAt - Date.now());
  }
  return Math.min(12000, 1000 * 2 ** attempt);
}

async function hubspotFetch(path, options = {}, attempt = 0) {
  if (!hasHubSpotToken()) {
    throw new Error('Missing HUBSPOT_PRIVATE_APP_TOKEN');
  }

  const response = await fetch(`${String(config.hubspot.apiBaseUrl).replace(/\/$/, '')}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.hubspot.privateAppToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    if (HUBSPOT_RETRY_STATUSES.has(response.status) && attempt < HUBSPOT_MAX_RETRIES) {
      await sleep(retryDelayMs(response, attempt));
      return hubspotFetch(path, options, attempt + 1);
    }
    const error = new Error(body.message || `HubSpot request failed with ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function booleanFromHubSpot(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return value === true || ['true', 'yes', 'y', '1', 'checked'].includes(normalized);
}

function mapContact(contact, owner) {
  const props = contact.properties || {};
  const field = config.hubspot.properties;
  const name = [props.firstname, props.lastname].filter(Boolean).join(' ') || props.email || 'Unnamed Contact';
  const rawTimeZone = props[field.timeZone] || props.timezone;

  return {
    hubspotId: contact.id,
    ownerId: owner.id,
    hubspotOwnerId: owner.hubspotOwnerId,
    name,
    company: props.company || '',
    phone: props.phone || props.mobilephone || '',
    email: props.email || '',
    timeZone: normalizeTimeZone(rawTimeZone),
    timeZoneLabel: displayTimeZone(rawTimeZone),
    status: props[field.leadStatus] || props.lifecyclestage || 'new',
    consent: booleanFromHubSpot(props[field.consent]),
    doNotCall: booleanFromHubSpot(props[field.doNotCall]),
    attempts: Number(props[field.attempts] || 0),
    lastOutcome: props[field.lastOutcome] || ''
  };
}

function mapOwner(owner) {
  const name = [owner.firstName, owner.lastName].filter(Boolean).join(' ') || owner.email || `HubSpot Owner ${owner.id}`;
  return {
    id: `hubspot_owner_${owner.id}`,
    hubspotOwnerId: String(owner.id),
    name,
    email: owner.email || '',
    agentPhone: config.defaultAgentPhone
  };
}

function callOutcomeBody(outcome) {
  if (outcome === 'live_answer') return 'Connected to a live person.';
  if (outcome === 'voicemail') return 'Voicemail detected.';
  if (outcome === 'no_answer') return 'No answer.';
  if (outcome === 'busy') return 'Line busy.';
  if (outcome === 'failed') return 'Call failed.';
  return `Call completed with outcome: ${outcome || 'unknown'}.`;
}

function hubspotLeadStatusValue(status) {
  const value = String(status || '').trim();
  if (!value) return '';
  const normalized = value.toLowerCase();
  return config.hubspot.leadStatusValues[normalized] || value;
}

function fallbackLeadStatusOptions() {
  return [
    { label: 'New', value: hubspotLeadStatusValue('new') },
    { label: 'Connected', value: hubspotLeadStatusValue('connected') },
    { label: 'Follow up', value: hubspotLeadStatusValue('follow_up') },
    { label: 'Qualified', value: hubspotLeadStatusValue('qualified') },
    { label: 'Not interested', value: hubspotLeadStatusValue('not_interested') },
    { label: 'Bad timing', value: hubspotLeadStatusValue('bad_timing') },
    { label: 'Do not call', value: hubspotLeadStatusValue('do_not_call') }
  ].filter((option, index, options) => (
    option.value && options.findIndex((item) => item.value === option.value) === index
  ));
}

const HUBSPOT_DISPOSITIONS = {
  live_answer: 'f240bbac-87c9-4f6e-bf70-924b57d47db7',
  voicemail: 'b2cf5968-551e-4856-9783-52b3da59a7d0',
  no_answer: '73a0d17f-1163-4015-bdd5-ec830791da20',
  busy: '9d9162e7-6cf3-4944-bf63-4dff82258764'
};

export async function fetchHubSpotOwners() {
  const result = await hubspotFetch('/crm/v3/owners/?limit=100');
  return (result.results || [])
    .filter((owner) => !owner.archived)
    .map(mapOwner);
}

function isMissingPropertyError(error) {
  const detail = JSON.stringify(error?.body || {});
  return error?.status === 400 && (
    detail.includes('PROPERTY_DOESNT_EXIST')
    || detail.includes('does not exist')
  );
}

export async function fetchContactsForOwner(owner, limit = 0) {
  const field = config.hubspot.properties;
  const contacts = [];
  const maximum = Number(limit) > 0 ? Math.floor(Number(limit)) : Number.POSITIVE_INFINITY;
  let after = '';

  do {
    const remaining = Number.isFinite(maximum) ? maximum - contacts.length : CONTACT_PAGE_SIZE;
    const body = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'hubspot_owner_id',
              operator: 'EQ',
              value: owner.hubspotOwnerId
            }
          ]
        }
      ],
      properties: [
        'firstname',
        'lastname',
        'email',
        'phone',
        'mobilephone',
        'company',
        'hubspot_owner_id',
        field.leadStatus,
        'lifecyclestage',
        field.consent,
        field.doNotCall,
        field.attempts,
        field.lastOutcome,
        field.timeZone,
        'timezone'
      ].filter((property, index, properties) => property && properties.indexOf(property) === index),
      limit: Math.min(CONTACT_PAGE_SIZE, Math.max(1, remaining))
    };

    if (after) body.after = after;

    const result = await hubspotFetch('/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: JSON.stringify(body)
    });

    contacts.push(...(result.results || []));
    after = result.paging?.next?.after || '';
    if (after) await sleep(250);
  } while (after && contacts.length < maximum);

  return contacts.slice(0, maximum).map((contact) => mapContact(contact, owner));
}

export async function fetchHubSpotLeadStatusOptions(options = {}) {
  const fallback = fallbackLeadStatusOptions();
  if (config.leadSource !== 'hubspot') {
    return { options: fallback, source: 'fallback' };
  }

  if (!options.refresh && leadStatusOptionsCache.options && leadStatusOptionsCache.expiresAt > Date.now()) {
    return { options: leadStatusOptionsCache.options, source: 'hubspot-cache' };
  }

  const field = config.hubspot.properties.leadStatus;
  const result = await hubspotFetch(`/crm/v3/properties/contacts/${encodeURIComponent(field)}`);
  const hubspotOptions = (result.options || [])
    .filter((option) => !option.hidden)
    .sort((a, b) => Number(a.displayOrder ?? 0) - Number(b.displayOrder ?? 0))
    .map((option) => ({
      label: option.label || option.value,
      value: option.value
    }))
    .filter((option) => option.value);

  const normalized = hubspotOptions.length ? hubspotOptions : fallback;
  leadStatusOptionsCache = {
    expiresAt: Date.now() + STATUS_OPTION_CACHE_MS,
    options: normalized
  };

  return { options: normalized, source: hubspotOptions.length ? 'hubspot' : 'fallback' };
}

export async function updateHubSpotLead(lead, patch) {
  if (!lead.hubspotId || String(lead.hubspotId).startsWith('mock-')) {
    return { skipped: true };
  }

  const field = config.hubspot.properties;
  const properties = {};
  if (patch.status) properties[field.leadStatus] = hubspotLeadStatusValue(patch.status);
  if (patch.lastOutcome) properties[field.lastOutcome] = patch.lastOutcome;
  if (typeof patch.attempts === 'number') properties[field.attempts] = String(patch.attempts);

  if (!Object.keys(properties).length) {
    return { skipped: true };
  }

  const updatePath = `/crm/v3/objects/contacts/${lead.hubspotId}`;
  try {
    return await hubspotFetch(updatePath, {
      method: 'PATCH',
      body: JSON.stringify({ properties })
    });
  } catch (error) {
    const entries = Object.entries(properties);
    if (entries.length <= 1) throw error;

    const results = {};
    const failures = [];
    const skippedProperties = [];
    for (const [property, value] of entries) {
      try {
        results[property] = await hubspotFetch(updatePath, {
          method: 'PATCH',
          body: JSON.stringify({ properties: { [property]: value } })
        });
      } catch (propertyError) {
        if (isMissingPropertyError(propertyError)) {
          skippedProperties.push(property);
        } else {
          failures.push(`${property}: ${propertyError.message}`);
        }
      }
    }

    if (!Object.keys(results).length && failures.length) {
      throw new Error(failures.join('; '));
    }

    return {
      partial: failures.length > 0,
      failures,
      skippedProperties,
      results
    };
  }
}

export async function createHubSpotCallLog(call, lead, outcome) {
  if (!lead?.hubspotId || String(lead.hubspotId).startsWith('mock-')) {
    return { skipped: true };
  }

  const startedAt = call.startedAt ? new Date(call.startedAt) : new Date();
  const completedAt = call.completedAt ? new Date(call.completedAt) : new Date();
  const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
  const agentName = String(call.agentName || '').trim();
  const properties = {
    hs_timestamp: startedAt.toISOString(),
    hs_call_title: `${agentName || 'TruckX Auto Dialer'}: ${lead.name || lead.phone}`,
    hs_call_body: [
      callOutcomeBody(outcome),
      agentName ? `Agent: ${agentName}.` : '',
      call.dispositionStatus ? `Agent outcome: ${call.dispositionStatus}.` : '',
      call.dispositionNote ? `Note: ${call.dispositionNote}` : ''
    ].filter(Boolean).join(' '),
    hs_call_direction: 'OUTBOUND',
    hs_call_status: 'COMPLETED',
    hs_call_from_number: call.callerIdNumber || config.callerIdNumber,
    hs_call_to_number: call.leadPhone || lead.phone,
    hs_call_duration: String(durationMs)
  };

  if (call.hubspotOwnerId) {
    properties.hubspot_owner_id = String(call.hubspotOwnerId);
  }

  if (HUBSPOT_DISPOSITIONS[outcome]) {
    properties.hs_call_disposition = HUBSPOT_DISPOSITIONS[outcome];
  }

  return hubspotFetch('/crm/v3/objects/calls', {
    method: 'POST',
    body: JSON.stringify({
      properties,
      associations: [
        {
          to: { id: lead.hubspotId },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: 194
            }
          ]
        }
      ]
    })
  });
}
