import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const storePath = path.resolve(process.cwd(), 'data', 'store.json');

function seedStore() {
  const now = new Date().toISOString();
  return {
    meta: {
      createdAt: now,
      updatedAt: now
    },
    owners: [
      {
        id: 'owner_demo_1',
        hubspotOwnerId: '1001',
        name: 'Demo Owner East',
        email: 'owner-east@example.com',
        agentPhone: '+15557654321'
      },
      {
        id: 'owner_demo_2',
        hubspotOwnerId: '1002',
        name: 'Demo Owner West',
        email: 'owner-west@example.com',
        agentPhone: '+15557654322'
      }
    ],
    leads: [
      {
        id: 'lead_001',
        hubspotId: 'mock-001',
        ownerId: 'owner_demo_1',
        hubspotOwnerId: '1001',
        name: 'Avery Johnson',
        company: 'Northstar Logistics',
        phone: '+12125550112',
        timeZone: 'America/New_York',
        status: 'new',
        consent: true,
        doNotCall: false,
        attempts: 0,
        lastOutcome: ''
      },
      {
        id: 'lead_002',
        hubspotId: 'mock-002',
        ownerId: 'owner_demo_1',
        hubspotOwnerId: '1001',
        name: 'Morgan Lee',
        company: 'Harbor Health',
        phone: '+13125550144',
        timeZone: 'America/Chicago',
        status: 'new',
        consent: true,
        doNotCall: false,
        attempts: 0,
        lastOutcome: ''
      },
      {
        id: 'lead_003',
        hubspotId: 'mock-003',
        ownerId: 'owner_demo_1',
        hubspotOwnerId: '1001',
        name: 'Casey Rivera',
        company: 'BrightPath Solar',
        phone: '+14085550177',
        timeZone: 'America/Los_Angeles',
        status: 'new',
        consent: true,
        doNotCall: false,
        attempts: 0,
        lastOutcome: ''
      },
      {
        id: 'lead_004',
        hubspotId: 'mock-004',
        ownerId: 'owner_demo_2',
        hubspotOwnerId: '1002',
        name: 'Taylor Brown',
        company: 'Summit Retail',
        phone: '+13035550188',
        timeZone: 'America/Denver',
        status: 'new',
        consent: true,
        doNotCall: false,
        attempts: 0,
        lastOutcome: ''
      },
      {
        id: 'lead_005',
        hubspotId: 'mock-005',
        ownerId: 'owner_demo_2',
        hubspotOwnerId: '1002',
        name: 'Jordan Smith',
        company: 'Cobalt SaaS',
        phone: '+16465550191',
        timeZone: 'America/New_York',
        status: 'do_not_call',
        consent: false,
        doNotCall: true,
        attempts: 0,
        lastOutcome: ''
      }
    ],
    campaigns: [],
    calls: [],
    events: [],
    dncNumbers: []
  };
}

function ensureStore() {
  if (!fs.existsSync(storePath)) {
    fs.writeFileSync(storePath, JSON.stringify(seedStore(), null, 2));
  }
}

function read() {
  ensureStore();
  const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  if (!Array.isArray(data.dncNumbers)) data.dncNumbers = [];
  if (!Array.isArray(data.events)) data.events = [];
  return data;
}

function write(data) {
  data.meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
  return data;
}

export function getStore() {
  return read();
}

export function updateStore(mutator) {
  const data = read();
  const result = mutator(data);
  write(data);
  return result ?? data;
}

export function addEvent(type, message, details = {}) {
  return updateStore((data) => {
    const event = {
      id: randomUUID(),
      type,
      message,
      details,
      createdAt: new Date().toISOString()
    };
    data.events.unshift(event);
    data.events = data.events.slice(0, 100);
    return event;
  });
}

export function createCampaign(input) {
  return updateStore((data) => {
    const owner = data.owners.find((item) => item.id === input.ownerId);
    if (!owner) {
      throw new Error('Owner not found');
    }

    const campaign = {
      id: randomUUID(),
      name: input.name || `${owner.name} Campaign`,
      ownerId: owner.id,
      hubspotOwnerId: owner.hubspotOwnerId,
      source: input.source || 'mock',
      status: 'draft',
      maxParallelCalls: Number(input.maxParallelCalls || 2),
      agentPhone: input.agentPhone || owner.agentPhone,
      callerIdNumbers: Array.isArray(input.callerIdNumbers) ? input.callerIdNumbers : [],
      callWindowStart: input.callWindowStart || '09:00',
      callWindowEnd: input.callWindowEnd || '18:00',
      voicemailDrop: Boolean(input.voicemailDrop),
      createdAt: new Date().toISOString(),
      startedAt: '',
      stoppedAt: ''
    };

    data.campaigns.unshift(campaign);
    data.events.unshift({
      id: randomUUID(),
      type: 'campaign_created',
      message: `Campaign created for ${owner.name}`,
      details: { campaignId: campaign.id },
      createdAt: new Date().toISOString()
    });

    return campaign;
  });
}

export function upsertOwners(owners) {
  return updateStore((data) => {
    const byHubspotOwnerId = new Map(data.owners.map((owner) => [owner.hubspotOwnerId, owner]));
    for (const incoming of owners) {
      const existing = byHubspotOwnerId.get(incoming.hubspotOwnerId);
      if (existing) {
        Object.assign(existing, incoming, { id: existing.id });
      } else {
        data.owners.push({ ...incoming, id: incoming.id || randomUUID() });
      }
    }
    return owners.length;
  });
}

export function setCampaignStatus(campaignId, status) {
  return updateStore((data) => {
    const campaign = data.campaigns.find((item) => item.id === campaignId);
    if (!campaign) {
      throw new Error('Campaign not found');
    }

    campaign.status = status;
    if (status === 'running' && !campaign.startedAt) {
      campaign.startedAt = new Date().toISOString();
    }
    if (status === 'stopped' || status === 'complete') {
      campaign.stoppedAt = new Date().toISOString();
    }
    return campaign;
  });
}

export function upsertLeads(leads) {
  return updateStore((data) => {
    const byHubspotId = new Map(data.leads.map((lead) => [lead.hubspotId, lead]));
    for (const incoming of leads) {
      const existing = byHubspotId.get(incoming.hubspotId);
      if (existing) {
        Object.assign(existing, incoming, { id: existing.id });
      } else {
        data.leads.push({ ...incoming, id: incoming.id || randomUUID() });
      }
    }
    return leads.length;
  });
}

export function updateLead(leadId, patch) {
  return updateStore((data) => {
    const lead = data.leads.find((item) => item.id === leadId);
    if (!lead) {
      throw new Error('Lead not found');
    }
    Object.assign(lead, patch);
    return lead;
  });
}

export function addDncNumber(input) {
  return updateStore((data) => {
    const phone = input.phone;
    const existing = data.dncNumbers.find((item) => item.phone === phone);
    if (existing) {
      Object.assign(existing, {
        reason: input.reason || existing.reason,
        source: input.source || existing.source,
        updatedAt: new Date().toISOString()
      });
      return existing;
    }

    const record = {
      id: randomUUID(),
      phone,
      reason: input.reason || 'Manual opt-out',
      source: input.source || 'manual',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    data.dncNumbers.unshift(record);

    for (const lead of data.leads) {
      if (lead.phone === phone) {
        lead.doNotCall = true;
        lead.status = 'do_not_call';
        lead.lastOutcome = 'do_not_call';
      }
    }

    data.events.unshift({
      id: randomUUID(),
      type: 'dnc_added',
      message: `Added ${phone} to DNC`,
      details: { phone },
      createdAt: new Date().toISOString()
    });

    return record;
  });
}

export function removeDncNumber(phone) {
  return updateStore((data) => {
    const before = data.dncNumbers.length;
    data.dncNumbers = data.dncNumbers.filter((item) => item.phone !== phone);
    const removed = before - data.dncNumbers.length;

    if (removed) {
      data.events.unshift({
        id: randomUUID(),
        type: 'dnc_removed',
        message: `Removed ${phone} from DNC`,
        details: { phone },
        createdAt: new Date().toISOString()
      });
    }

    return { removed };
  });
}

export function addCall(call) {
  return updateStore((data) => {
    const record = {
      id: call.id || randomUUID(),
      status: 'dialing',
      startedAt: new Date().toISOString(),
      completedAt: '',
      outcome: '',
      ...call
    };
    data.calls.unshift(record);
    return record;
  });
}

export function updateCall(callId, patch) {
  return updateStore((data) => {
    const call = data.calls.find((item) => item.id === callId);
    if (!call) {
      throw new Error('Call not found');
    }
    Object.assign(call, patch);
    return call;
  });
}
