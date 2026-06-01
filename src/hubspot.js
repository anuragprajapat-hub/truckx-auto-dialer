import { config } from './config.js';

const HUBSPOT_BASE = 'https://api.hubapi.com';

function hasHubSpotToken() {
  return Boolean(config.hubspot.privateAppToken);
}

async function hubspotFetch(path, options = {}) {
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
    throw new Error(body.message || `HubSpot request failed with ${response.status}`);
  }

  return body;
}

function mapContact(contact, owner) {
  const props = contact.properties || {};
  const field = config.hubspot.properties;
  const name = [props.firstname, props.lastname].filter(Boolean).join(' ') || props.email || 'Unnamed Contact';

  return {
    hubspotId: contact.id,
    ownerId: owner.id,
    hubspotOwnerId: owner.hubspotOwnerId,
    name,
    company: props.company || '',
    phone: props.phone || props.mobilephone || '',
    email: props.email || '',
    timeZone: props[field.timeZone] || props.timezone || 'America/New_York',
    status: props[field.leadStatus] || props.lifecyclestage || 'new',
    consent: props[field.consent] === 'true' || props[field.consent] === true,
    doNotCall: props[field.doNotCall] === 'true' || props[field.doNotCall] === true,
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

export async function fetchContactsForOwner(owner, limit = 100) {
  const field = config.hubspot.properties;
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
    limit
  };

  const result = await hubspotFetch('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: JSON.stringify(body)
  });

  return (result.results || []).map((contact) => mapContact(contact, owner));
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

  return hubspotFetch(`/crm/v3/objects/contacts/${lead.hubspotId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties })
  });
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
    hs_call_title: `Truckx Auto Dialer: ${lead.name || lead.phone}`,
    hs_call_body: callOutcomeBody(outcome),
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
