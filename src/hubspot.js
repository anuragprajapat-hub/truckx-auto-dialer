import { config } from './config.js';
import { displayTimeZone, normalizeTimeZone } from './timeZones.js';

const HUBSPOT_BASE = 'https://api.hubapi.com';
const HUBSPOT_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const HUBSPOT_MAX_RETRIES = 4;

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

  const response = await fetch(`${HUBSPOT_BASE}${path}`, {
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
    throw new Error(body.message || `HubSpot request failed with ${response.status}`);
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

export async function fetchContactsForOwner(owner, limit = config.hubspot.syncLimit) {
  const field = config.hubspot.properties;
  const contacts = [];
  let after = '';

  do {
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
      limit: Math.min(100, Math.max(1, limit - contacts.length))
    };

    if (after) body.after = after;

    const result = await hubspotFetch('/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: JSON.stringify(body)
    });

    contacts.push(...(result.results || []));
    after = result.paging?.next?.after || '';
    if (after) await sleep(350);
  } while (after && contacts.length < limit);

  return contacts.map((contact) => mapContact(contact, owner));
}

export async function updateHubSpotLead(lead, patch) {
  if (!lead.hubspotId || String(lead.hubspotId).startsWith('mock-')) {
    return { skipped: true };
  }

  const field = config.hubspot.properties;
  const properties = {};
  if (patch.status) properties[field.leadStatus] = patch.status;
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
    for (const [property, value] of entries) {
      try {
        results[property] = await hubspotFetch(updatePath, {
          method: 'PATCH',
          body: JSON.stringify({ properties: { [property]: value } })
        });
      } catch (propertyError) {
        failures.push(`${property}: ${propertyError.message}`);
      }
    }

    if (failures.length === entries.length) {
      throw new Error(failures.join('; '));
    }

    return {
      partial: failures.length > 0,
      failures,
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
  const properties = {
    hs_timestamp: startedAt.toISOString(),
    hs_call_title: `TruckX Auto Dialer: ${lead.name || lead.phone}`,
    hs_call_body: [
      callOutcomeBody(outcome),
      call.dispositionStatus ? `Agent outcome: ${call.dispositionStatus}.` : '',
      call.dispositionNote ? `Note: ${call.dispositionNote}` : ''
    ].filter(Boolean).join(' '),
    hs_call_direction: 'OUTBOUND',
    hs_call_status: 'COMPLETED',
    hs_call_from_number: call.callerIdNumber || config.callerIdNumber,
    hs_call_to_number: call.leadPhone || lead.phone,
    hs_call_duration: String(durationMs)
  };

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
