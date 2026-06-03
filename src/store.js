import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

const storePath = path.resolve(process.cwd(), 'data', 'store.json');
const storeId = 'default';
const { Pool } = pg;

let cachedStore = null;
let pool = null;
let initialized = false;
let writeQueue = Promise.resolve();

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
    sessions: [],
    agents: [],
    agentInvites: [],
    events: [],
    dncNumbers: []
  };
}

function ensureStore() {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  if (!fs.existsSync(storePath)) {
    fs.writeFileSync(storePath, JSON.stringify(seedStore(), null, 2));
  }
}

function normalizeStore(data) {
  data = data && typeof data === 'object' ? data : seedStore();
  if (!data.meta) data.meta = {};
  if (!data.meta.createdAt) data.meta.createdAt = new Date().toISOString();
  if (!data.meta.updatedAt) data.meta.updatedAt = data.meta.createdAt;
  if (!Array.isArray(data.dncNumbers)) data.dncNumbers = [];
  if (!Array.isArray(data.events)) data.events = [];
  if (!Array.isArray(data.sessions)) data.sessions = [];
  if (!Array.isArray(data.agents)) data.agents = [];
  if (!Array.isArray(data.agentInvites)) data.agentInvites = [];
  if (!Array.isArray(data.owners)) data.owners = [];
  if (!Array.isArray(data.leads)) data.leads = [];
  if (!Array.isArray(data.campaigns)) data.campaigns = [];
  if (!Array.isArray(data.calls)) data.calls = [];
  for (const campaign of data.campaigns || []) {
    if (!campaign.timeZoneTarget) campaign.timeZoneTarget = 'ALL';
    if (typeof campaign.pauseOnLiveAnswer !== 'boolean') campaign.pauseOnLiveAnswer = true;
    if (!campaign.dialMode) campaign.dialMode = 'predictive';
  }
  return data;
}

function readFileStore() {
  ensureStore();
  return normalizeStore(JSON.parse(fs.readFileSync(storePath, 'utf8')));
}

function writeFileStore(data) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  data.meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
  return data;
}

function postgresSsl() {
  const mode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase();
  if (mode === 'require' || mode === 'true') return { rejectUnauthorized: false };
  if (mode === 'disable' || mode === 'false') return false;
  if (String(process.env.DATABASE_URL || '').includes('sslmode=require')) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

async function writePostgresStore(data) {
  await pool.query(
    `
      insert into truckx_app_store (id, data, updated_at)
      values ($1, $2::jsonb, now())
      on conflict (id)
      do update set data = excluded.data, updated_at = now()
    `,
    [storeId, JSON.stringify(data)]
  );
}

async function initPostgresStore() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: postgresSsl()
  });

  await pool.query(`
    create table if not exists truckx_app_store (
      id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);

  const result = await pool.query('select data from truckx_app_store where id = $1', [storeId]);
  if (result.rows[0]?.data) {
    cachedStore = normalizeStore(result.rows[0].data);
    return;
  }

  cachedStore = readFileStore();
  await writePostgresStore(cachedStore);
}

export async function initStore() {
  if (initialized) return;
  if (process.env.DATABASE_URL) {
    try {
      await initPostgresStore();
      initialized = true;
      return;
    } catch (error) {
      console.error(`Postgres store unavailable, falling back to local file: ${error.message}`);
      pool = null;
    }
  }

  cachedStore = readFileStore();
  initialized = true;
}

export function storeBackend() {
  return pool ? 'postgres' : 'file';
}

export async function flushStore() {
  await writeQueue;
}

export async function closeStore() {
  await flushStore();
  if (pool) await pool.end();
}

function read() {
  if (!cachedStore) cachedStore = readFileStore();
  return normalizeStore(cachedStore);
}

function write(data) {
  data.meta.updatedAt = new Date().toISOString();
  cachedStore = data;

  if (!pool) {
    writeFileStore(data);
    return data;
  }

  const snapshot = JSON.parse(JSON.stringify(data));
  writeQueue = writeQueue
    .then(() => writePostgresStore(snapshot))
    .catch((error) => {
      console.error(`Postgres store write failed: ${error.message}`);
    });
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
      maxParallelCalls: Math.max(1, Math.min(10, Number(input.maxParallelCalls || 2))),
      agentPhone: input.agentPhone || owner.agentPhone,
      callerIdNumbers: Array.isArray(input.callerIdNumbers) ? input.callerIdNumbers : [],
      timeZoneTarget: String(input.timeZoneTarget || 'ALL').toUpperCase(),
      dialMode: input.dialMode || 'predictive',
      pauseOnLiveAnswer: input.pauseOnLiveAnswer !== false,
      callWindowStart: input.callWindowStart || '09:00',
      callWindowEnd: input.callWindowEnd || '18:00',
      voicemailDrop: Boolean(input.voicemailDrop),
      createdAt: new Date().toISOString(),
      startedAt: '',
      stoppedAt: '',
      currentSessionId: ''
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
    if (owners.length) {
      data.owners = data.owners.filter((owner) => !String(owner.id || '').startsWith('owner_demo_'));
    }
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

function inviteToken() {
  return randomBytes(24).toString('base64url');
}

function defaultInviteUrl(token, publicBaseUrl) {
  const baseUrl = String(publicBaseUrl || '').replace(/\/$/, '');
  return `${baseUrl || 'http://localhost:4242'}/extension/?invite=${encodeURIComponent(token)}`;
}

export function createAgentInvite(input, publicBaseUrl) {
  return updateStore((data) => {
    const email = String(input.email || '').trim().toLowerCase();
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Agent name is required');
    if (!email || !email.includes('@')) throw new Error('Agent email is required');

    const owner = data.owners.find((item) => item.id === input.ownerId || item.hubspotOwnerId === input.hubspotOwnerId);
    const existing = data.agents.find((agent) => agent.email.toLowerCase() === email);
    const now = new Date().toISOString();
    const agent = existing || {
      id: randomUUID(),
      name,
      email,
      ownerId: owner?.id || '',
      hubspotOwnerId: owner?.hubspotOwnerId || String(input.hubspotOwnerId || ''),
      status: 'invited',
      extensionStatus: 'not_installed',
      apiToken: '',
      invitedAt: now,
      acceptedAt: '',
      lastSeenAt: '',
      createdAt: now,
      updatedAt: now
    };

    Object.assign(agent, {
      name,
      email,
      ownerId: owner?.id || agent.ownerId || '',
      hubspotOwnerId: owner?.hubspotOwnerId || agent.hubspotOwnerId || String(input.hubspotOwnerId || ''),
      status: agent.status === 'active' ? 'active' : 'invited',
      invitedAt: now,
      updatedAt: now
    });

    if (!existing) data.agents.unshift(agent);

    const token = inviteToken();
    const invite = {
      id: randomUUID(),
      token,
      agentId: agent.id,
      email,
      status: 'pending',
      inviteUrl: defaultInviteUrl(token, publicBaseUrl),
      emailSent: false,
      emailError: '',
      createdAt: now,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString(),
      acceptedAt: ''
    };

    data.agentInvites.unshift(invite);
    data.events.unshift({
      id: randomUUID(),
      type: 'agent_invited',
      message: `Invited ${agent.name}`,
      details: { agentId: agent.id, email },
      createdAt: now
    });

    return { agent, invite };
  });
}

export function updateAgentInviteEmailStatus(inviteId, patch) {
  return updateStore((data) => {
    const invite = data.agentInvites.find((item) => item.id === inviteId);
    if (!invite) throw new Error('Invite not found');
    Object.assign(invite, patch);
    return invite;
  });
}

export function getAgentInvite(token) {
  const data = getStore();
  const invite = data.agentInvites.find((item) => item.token === token);
  if (!invite) return null;
  const agent = data.agents.find((item) => item.id === invite.agentId);
  return { invite, agent };
}

export function acceptAgentInvite(token, input = {}) {
  return updateStore((data) => {
    const invite = data.agentInvites.find((item) => item.token === token);
    if (!invite) throw new Error('Invite not found');

    const agent = data.agents.find((item) => item.id === invite.agentId);
    if (!agent) throw new Error('Agent not found');

    if (invite.status === 'accepted' && agent.status === 'active' && agent.apiToken) {
      agent.lastSeenAt = new Date().toISOString();
      agent.extensionStatus = 'connected';
      agent.updatedAt = agent.lastSeenAt;
      return {
        agent: { ...agent, apiToken: agent.apiToken },
        token: agent.apiToken,
        alreadyAccepted: true
      };
    }

    if (invite.status !== 'pending') throw new Error('Invite is no longer active');
    if (new Date(invite.expiresAt).getTime() < Date.now()) throw new Error('Invite has expired');

    const now = new Date().toISOString();
    const apiToken = `txa_${inviteToken()}`;
    Object.assign(agent, {
      name: String(input.name || agent.name).trim() || agent.name,
      status: 'active',
      extensionStatus: 'connected',
      apiToken,
      acceptedAt: now,
      lastSeenAt: now,
      updatedAt: now
    });
    Object.assign(invite, {
      status: 'accepted',
      acceptedAt: now
    });

    data.events.unshift({
      id: randomUUID(),
      type: 'agent_invite_accepted',
      message: `${agent.name} accepted the invite`,
      details: { agentId: agent.id, email: agent.email },
      createdAt: now
    });

    return {
      agent: { ...agent, apiToken },
      token: apiToken
    };
  });
}

export function agentFromApiToken(token) {
  if (!token) return null;
  const data = getStore();
  const agent = data.agents.find((item) => item.apiToken === token && item.status === 'active');
  if (!agent) return null;
  return agent;
}

export function touchAgent(agentId) {
  return updateStore((data) => {
    const agent = data.agents.find((item) => item.id === agentId);
    if (!agent) throw new Error('Agent not found');
    agent.lastSeenAt = new Date().toISOString();
    agent.extensionStatus = 'connected';
    agent.updatedAt = agent.lastSeenAt;
    return agent;
  });
}

export function setCampaignStatus(campaignId, status) {
  return updateStore((data) => {
    const campaign = data.campaigns.find((item) => item.id === campaignId);
    if (!campaign) {
      throw new Error('Campaign not found');
    }

    const now = new Date().toISOString();
    const previousStatus = campaign.status;
    campaign.status = status;

    if (status === 'running' && previousStatus !== 'running') {
      if (!campaign.startedAt) campaign.startedAt = now;
      campaign.stoppedAt = '';
      const session = {
        id: randomUUID(),
        campaignId: campaign.id,
        ownerId: campaign.ownerId,
        startedAt: now,
        endedAt: '',
        endedReason: ''
      };
      data.sessions.unshift(session);
      campaign.currentSessionId = session.id;
    }

    if (['stopped', 'complete', 'paused'].includes(status)) {
      campaign.stoppedAt = now;
      const session = data.sessions.find((item) => item.id === campaign.currentSessionId && !item.endedAt);
      if (session) {
        session.endedAt = now;
        session.endedReason = status;
      }
      campaign.currentSessionId = '';
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
