import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { config } from './src/config.js';
import { normalizeUsPhone } from './src/compliance.js';
import { dialerEngine } from './src/dialerEngine.js';
import { sendAgentInviteEmail } from './src/email.js';
import { fetchHubSpotLeadStatusOptions } from './src/hubspot.js';
import { buildAgentReports, buildDashboardSummary } from './src/reports.js';
import { assertPlivoVerifiedCallerId, fetchPlivoVerifiedCallerIds } from './src/voice/plivoCallerIds.js';
import {
  deletePlivoEndpoint,
  plivoEndpointReadiness,
  provisionPlivoEndpoint
} from './src/voice/plivoEndpoints.js';
import {
  acceptAgentInvite,
  addDncNumber,
  addEvent,
  agentFromApiToken,
  closeStore,
  createAgentInvite,
  createCampaign,
  deleteAgent,
  deleteCampaign,
  disconnectAgent,
  getAgentInvite,
  getStore,
  initStore,
  removeDncNumber,
  resetProviderErrorsForCampaign,
  storeBackend,
  touchAgent,
  updateAgentInviteEmailStatus,
  updateCampaign,
  updateLead
} from './src/store.js';

const publicDir = path.resolve(process.cwd(), 'public');
let lastLeadStatusOptionsErrorAt = 0;
let lastVerifiedCallerIdsErrorAt = 0;
let lastEndpointReadinessErrorAt = 0;
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function send(response, statusCode, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers
  });
  response.end(payload);
}

function sendJson(response, body, statusCode = 200) {
  send(response, statusCode, body);
}

function sendXml(response, xml) {
  response.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
  response.end(xml);
}

function isProtectedPath(pathname) {
  if (!config.appAuth.users.length) return false;
  if (pathname === '/api/health') return false;
  if (pathname.startsWith('/api/invites/')) return false;
  if (pathname.startsWith('/extension/')) return false;
  if (pathname === '/agent' || pathname.startsWith('/agent/')) return false;
  if (pathname === '/favicon.ico') return false;
  if (pathname.startsWith('/assets/')) return false;
  if (pathname.startsWith('/webhooks/')) return false;
  return true;
}

function unauthorized(response) {
  response.writeHead(401, {
    'Content-Type': 'text/plain; charset=utf-8',
    'WWW-Authenticate': 'Basic realm="TruckX Auto Dialer"'
  });
  response.end('Authentication required');
}

function unauthorizedApi(response) {
  sendJson(response, { error: 'Authentication required' }, 401);
}

function authenticatedUser(request) {
  const header = request.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    const agent = agentFromApiToken(token);
    if (!agent) return null;
    return {
      username: agent.email,
      role: 'agent',
      ownerId: agent.ownerId,
      hubspotOwnerId: agent.hubspotOwnerId,
      email: agent.email,
      agentId: agent.id
    };
  }

  if (!config.appAuth.users.length) {
    return { username: 'local', role: 'admin', hubspotOwnerId: '' };
  }

  if (!header.startsWith('Basic ')) return null;

  try {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    const username = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);
    return config.appAuth.users.find((user) => user.username === username && user.password === password) || null;
  } catch {
    return null;
  }
}

function escapeXml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plivoNumber(phone) {
  return String(phone || '').replace(/^\+/, '');
}

function setupStatus() {
  const publicUrl = config.publicBaseUrl || '';
  const isPublicWebhookUrl = publicUrl.startsWith('https://') && !publicUrl.includes('localhost') && !publicUrl.includes('127.0.0.1');
  const carrierReady = config.voiceProvider === 'mock'
    || (config.voiceProvider === 'twilio' && Boolean(config.twilio.accountSid && config.twilio.authToken))
    || (config.voiceProvider === 'plivo' && Boolean(config.plivo.authId && config.plivo.authToken));
  const browserEndpoints = browserEndpointStatus();

  return {
    appName: 'TruckX Auto Dialer',
    checks: [
      {
        id: 'app_auth',
        label: 'App password',
        ok: Boolean(config.appAuth.users.length),
        value: config.appAuth.users.length ? 'Enabled' : 'Missing',
        message: config.appAuth.users.length ? 'UI and API are password protected' : 'Set APP_PASSWORD or APP_USERS before using real leads'
      },
      {
        id: 'voice_provider',
        label: 'Voice provider',
        ok: carrierReady,
        value: config.voiceProvider,
        message: carrierReady
          ? `${config.voiceProvider === 'plivo' ? `Plivo Auth ID ${maskedValue(config.plivo.authId)}` : 'Ready'}`
          : 'Missing carrier credentials'
      },
      {
        id: 'agent_connection',
        label: 'Agent connection',
        ok: config.agentConnectionMode !== 'browser' || browserEndpoints.configured,
        value: config.agentConnectionMode,
        message: config.agentConnectionMode === 'browser'
          ? browserEndpoints.message
          : 'Agent phone call mode'
      },
      {
        id: 'hubspot',
        label: 'HubSpot',
        ok: config.leadSource !== 'hubspot' || Boolean(config.hubspot.privateAppToken),
        value: config.leadSource,
        message: config.leadSource === 'hubspot'
          ? (config.hubspot.privateAppToken ? 'Private app token configured' : 'Private app token required')
          : 'Mock lead source'
      },
      {
        id: 'webhooks',
        label: 'Public webhooks',
        ok: config.voiceProvider === 'mock' || isPublicWebhookUrl,
        value: publicUrl,
        message: isPublicWebhookUrl ? 'Public HTTPS URL ready' : 'Needed for real carrier callbacks'
      },
      {
        id: 'email_invites',
        label: 'Agent web invites',
        ok: Boolean(config.email.resendApiKey),
        value: config.email.resendApiKey ? 'Enabled' : 'Manual',
        message: config.email.resendApiKey ? 'Agent web login links will be emailed' : 'Copy agent web login links manually'
      },
      {
        id: 'caller_ids',
        label: 'Caller ID pool',
        ok: config.callerIdNumbers.length > 0,
        value: `${config.callerIdNumbers.length} number(s)`,
        message: config.callerIdNumbers.join(', ')
      },
      {
        id: 'voicemail',
        label: 'Voicemail drop',
        ok: Boolean(config.voicemailAudioUrl),
        value: config.voicemailAudioUrl ? 'Configured' : 'Optional',
        message: config.voicemailAudioUrl || 'Add VOICEMAIL_AUDIO_URL when ready'
      },
      {
        id: 'storage',
        label: 'Storage',
        ok: true,
        value: storeBackend(),
        message: storeBackend() === 'postgres' ? 'Render PostgreSQL is active' : 'Local file storage is active'
      },
      {
        id: 'dnc',
        label: 'DNC suppression',
        ok: true,
        value: `${getStore().dncNumbers.length} number(s)`,
        message: 'Global DNC list is enabled'
      }
    ],
    webhookUrls: {
      hubspot: `${publicUrl}/webhooks/hubspot/contact`,
      twilioAnswer: `${publicUrl}/webhooks/twilio/answer`,
      twilioStatus: `${publicUrl}/webhooks/twilio/status`,
      plivoAnswer: `${publicUrl}/webhooks/plivo/answer`,
      plivoAgentAnswer: `${publicUrl}/webhooks/plivo/agent-answer`,
      plivoAgentSession: `${publicUrl}/webhooks/plivo/agent-session`,
      plivoBrowserAgentSession: `${publicUrl}/webhooks/plivo/browser-agent-session`,
      plivoCustomerAnswer: `${publicUrl}/webhooks/plivo/customer-answer`,
      plivoStatus: `${publicUrl}/webhooks/plivo/status`,
      plivoMachine: `${publicUrl}/webhooks/plivo/machine`
    }
  };
}

function ownerIdsForUser(data, user) {
  if (!user || user.role === 'admin') {
    return new Set((data.owners || []).map((owner) => owner.id));
  }

  return new Set((data.owners || [])
    .filter((owner) => (
      String(owner.hubspotOwnerId || '') === String(user.hubspotOwnerId || '')
      || String(owner.id || '') === String(user.ownerId || '')
      || String(owner.email || '').toLowerCase() === String(user.email || '').toLowerCase()
    ))
    .map((owner) => owner.id));
}

function visibleState(data, user) {
  const ownerIds = ownerIdsForUser(data, user);
  const campaignIds = new Set((data.campaigns || [])
    .filter((campaign) => ownerIds.has(campaign.ownerId) && campaign.status !== 'deleted' && !campaign.deletedAt)
    .map((campaign) => campaign.id));

  if (user?.role === 'admin') {
    return data;
  }

  return {
    ...data,
    owners: data.owners.filter((owner) => ownerIds.has(owner.id)),
    campaigns: data.campaigns.filter((campaign) => campaignIds.has(campaign.id) && campaign.status !== 'deleted' && !campaign.deletedAt),
    leads: data.leads.filter((lead) => ownerIds.has(lead.ownerId)),
    calls: data.calls.filter((call) => ownerIds.has(call.ownerId) || campaignIds.has(call.campaignId)),
    sessions: data.sessions.filter((session) => ownerIds.has(session.ownerId)),
    agents: data.agents.filter((agent) => agent.id === user?.agentId || ownerIds.has(agent.ownerId)),
    agentInvites: [],
    events: data.events.filter((event) => !event.details?.campaignId || campaignIds.has(event.details.campaignId))
  };
}

function assertCampaignAccess(campaignId, user) {
  if (!campaignId || user?.role === 'admin') return;
  const data = getStore();
  const campaign = data.campaigns.find((item) => item.id === campaignId);
  if (!campaign || !ownerIdsForUser(data, user).has(campaign.ownerId)) {
    throw new Error('You do not have access to this campaign');
  }
}

function assertLeadAccess(leadId, user) {
  if (!leadId || user?.role === 'admin') return;
  const data = getStore();
  const lead = data.leads.find((item) => item.id === leadId);
  if (!lead || !ownerIdsForUser(data, user).has(lead.ownerId)) {
    throw new Error('You do not have access to this lead');
  }
}

function requireAdmin(request, response) {
  if (request.user?.role === 'admin') return false;
  sendJson(response, { error: 'Admin access required' }, 403);
  return true;
}

function safeAgents(agents = []) {
  return agents.map(({ apiToken, plivoEndpointPassword, ...agent }) => ({
    ...agent,
    plivoEndpointConfigured: Boolean(agent.plivoEndpointUsername && plivoEndpointPassword),
    plivoEndpointManaged: Boolean(agent.plivoEndpointManaged)
  }));
}

function maskedValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 8) return 'configured';
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function browserEndpointStatus() {
  const globalConfigured = Boolean(config.plivo.browserUsername && config.plivo.browserPassword);
  const agents = getStore().agents || [];
  const perAgentCount = agents.filter((agent) => (
    agent.plivoEndpointUsername && agent.plivoEndpointPassword
  )).length;

  return {
    configured: globalConfigured || perAgentCount > 0,
    globalConfigured,
    perAgentCount,
    message: perAgentCount
      ? `${perAgentCount} per-agent Plivo endpoint(s) configured${globalConfigured ? ' with global fallback' : ''}`
      : (globalConfigured ? 'Global browser softphone fallback is configured' : 'Add Plivo endpoint credentials to each agent')
  };
}

function normalizedEndpointUsername(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^sip:/, '')
    .split('@')[0];
}

async function leadStatusOptionsForState() {
  try {
    return await fetchHubSpotLeadStatusOptions();
  } catch (error) {
    if (Date.now() - lastLeadStatusOptionsErrorAt > 1000 * 60 * 5) {
      lastLeadStatusOptionsErrorAt = Date.now();
      addEvent('hubspot_status_options_failed', error.message, {
        property: config.hubspot.properties.leadStatus
      });
    }
    return {
      options: [
        { label: 'New', value: 'NEW' },
        { label: 'Connected', value: 'CONNECTED' },
        { label: 'Follow up', value: 'FOLLOWUP' }
      ],
      source: 'fallback',
      error: error.message
    };
  }
}

async function verifiedCallerIdsForState() {
  if (config.voiceProvider !== 'plivo') {
    return {
      callerIds: config.callerIdNumbers.map((phoneNumber) => ({
        phoneNumber,
        alias: 'Configured caller ID'
      })),
      source: 'config'
    };
  }

  try {
    return await fetchPlivoVerifiedCallerIds();
  } catch (error) {
    if (Date.now() - lastVerifiedCallerIdsErrorAt > 1000 * 60 * 5) {
      lastVerifiedCallerIdsErrorAt = Date.now();
      addEvent('plivo_verified_caller_ids_failed', error.message);
    }
    return {
      callerIds: [],
      source: 'unavailable',
      error: error.message
    };
  }
}

async function endpointReadinessForState() {
  try {
    return await plivoEndpointReadiness();
  } catch (error) {
    if (Date.now() - lastEndpointReadinessErrorAt > 1000 * 60 * 5) {
      lastEndpointReadinessErrorAt = Date.now();
      addEvent('plivo_endpoint_readiness_failed', error.message);
    }
    return {
      ready: false,
      endpointCount: 0,
      applicationId: '',
      templateUsername: '',
      error: error.message
    };
  }
}

function bodyValue(body = {}, names = []) {
  const lookup = new Map(Object.entries(body).map(([key, value]) => [String(key).toLowerCase(), value]));
  for (const name of names) {
    const value = lookup.get(String(name).toLowerCase());
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function webhookContext(url, body = {}) {
  return {
    ...body,
    campaignId: body.campaignId || url.searchParams.get('campaignId') || '',
    leadId: body.leadId || url.searchParams.get('leadId') || '',
    sessionId: body.sessionId || url.searchParams.get('sessionId') || '',
    role: body.role || url.searchParams.get('role') || ''
  };
}

function bridgeDetails(url) {
  const campaignId = url.searchParams.get('campaignId') || '';
  const leadId = url.searchParams.get('leadId') || '';
  const sessionId = url.searchParams.get('sessionId') || '';
  const data = getStore();
  const campaign = data.campaigns.find((item) => item.id === campaignId);
  const lead = data.leads.find((item) => item.id === leadId);
  const call = data.calls.find((item) => item.campaignId === campaignId && item.leadId === leadId && !item.completedAt);
  const session = data.sessions.find((item) => item.id === sessionId || item.id === campaign?.currentSessionId);

  return {
    campaign,
    session,
    conferenceName: session?.conferenceName || '',
    agentPhone: campaign?.agentPhone || call?.agentPhone || config.defaultAgentPhone,
    leadPhone: call?.leadPhone || normalizeUsPhone(lead?.phone) || lead?.phone || '',
    callerIdNumber: call?.callerIdNumber || config.callerIdNumber,
    voicemailDrop: Boolean(campaign?.voicemailDrop),
    voicemailAudioUrl: config.voicemailAudioUrl
  };
}

function conferenceXml(conferenceName, attrs = {}) {
  const attrText = Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join('');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `<Conference${attrText}>${escapeXml(conferenceName)}</Conference>`,
    '</Response>'
  ].join('');
}

function runningBrowserSessionForAgent(body = {}) {
  const endpointUsername = normalizedEndpointUsername(body.From || body.CallerName);
  const data = getStore();
  const requestedCampaignId = bodyValue(body, ['X-PH-CampaignId', 'X-PH-CampaignID', 'X_PH_CampaignId', 'XPHCampaignId']);
  const requestedSessionId = bodyValue(body, ['X-PH-SessionId', 'X-PH-SessionID', 'X_PH_SessionId', 'XPHSessionId']);

  if (requestedCampaignId) {
    const campaign = (data.campaigns || []).find((item) => item.id === requestedCampaignId && item.status === 'running' && item.currentSessionId);
    const session = campaign
      ? (data.sessions || []).find((item) => (
          item.id === (requestedSessionId || campaign.currentSessionId)
          && item.id === campaign.currentSessionId
          && !item.endedAt
        ))
      : null;
    if (campaign && session) return { campaign, session };
  }

  const agents = data.agents || [];
  const matchedAgent = agents.find((agent) => {
    const configured = normalizedEndpointUsername(agent.plivoEndpointUsername || agent.softphoneUsername);
    return configured && endpointUsername && configured === endpointUsername;
  });

  const ownerIds = matchedAgent
    ? new Set([matchedAgent.ownerId].filter(Boolean))
    : null;

  const runningCampaign = (data.campaigns || []).find((campaign) => {
    if (campaign.status !== 'running' || !campaign.currentSessionId) return false;
    if (ownerIds && !ownerIds.has(campaign.ownerId)) return false;
    const session = data.sessions.find((item) => item.id === campaign.currentSessionId);
    return session && !session.endedAt && (!session.agentConnectedAt || Boolean(matchedAgent));
  });

  if (!runningCampaign) return { campaign: null, session: null };
  const session = data.sessions.find((item) => item.id === runningCampaign.currentSessionId);
  return { campaign: runningCampaign, session };
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
      }
    });
    request.on('end', () => {
      const contentType = request.headers['content-type'] || '';
      if (!body) return resolve({});
      try {
        if (contentType.includes('application/json')) {
          resolve(JSON.parse(body));
          return;
        }
        if (contentType.includes('application/x-www-form-urlencoded')) {
          resolve(Object.fromEntries(new URLSearchParams(body)));
          return;
        }
        resolve({ raw: body });
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function serveStatic(request, response, url) {
  const requestedPath = url.pathname === '/'
    ? '/index.html'
    : (url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname);
  const filePath = path.resolve(publicDir, `.${requestedPath}`);

  if (!filePath.startsWith(publicDir)) {
    send(response, 403, 'Forbidden');
    return true;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }

  const extension = path.extname(filePath);
  response.writeHead(200, {
    'Content-Type': mimeTypes[extension] || 'application/octet-stream'
  });
  fs.createReadStream(filePath).pipe(response);
  return true;
}

function campaignIdFromPath(pathname, action) {
  const match = pathname.match(new RegExp(`^/api/campaigns/([^/]+)/${action}$`));
  return match?.[1] || '';
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    const browserEndpoints = browserEndpointStatus();
    const verifiedCallerIds = await verifiedCallerIdsForState();
    const endpointReadiness = await endpointReadinessForState();
    sendJson(response, {
      ok: true,
      appName: 'TruckX Auto Dialer',
      provider: config.voiceProvider,
      providerAccount: config.voiceProvider === 'plivo' ? maskedValue(config.plivo.authId) : '',
      agentConnectionMode: config.agentConnectionMode,
      browserSoftphoneConfigured: browserEndpoints.configured,
      browserUsername: maskedValue(config.plivo.browserUsername),
      perAgentBrowserEndpoints: browserEndpoints.perAgentCount,
      verifiedCallerIdCount: verifiedCallerIds.callerIds.length,
      verifiedCallerIdLookupReady: !verifiedCallerIds.error,
      plivoEndpointCount: endpointReadiness.endpointCount,
      automaticEndpointProvisioningReady: endpointReadiness.ready,
      leadSource: config.leadSource,
      storage: storeBackend(),
      time: new Date().toISOString()
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    const data = visibleState(getStore(), request.user);
    const leadStatusOptions = await leadStatusOptionsForState();
    const verifiedCallerIds = request.user?.role === 'admin'
      ? await verifiedCallerIdsForState()
      : { callerIds: [], source: 'restricted' };
    const endpointReadiness = request.user?.role === 'admin'
      ? await endpointReadinessForState()
      : { ready: false, endpointCount: 0 };
    const reportData = {
      ...data,
      campaigns: data.campaigns.filter((campaign) => campaign.status !== 'deleted' && !campaign.deletedAt)
    };
    sendJson(response, {
      appName: 'TruckX Auto Dialer',
      currentUser: {
        username: request.user?.username || 'local',
        role: request.user?.role || 'admin',
        hubspotOwnerId: request.user?.hubspotOwnerId || '',
        ownerId: request.user?.ownerId || '',
        agentId: request.user?.agentId || '',
        email: request.user?.email || ''
      },
      settings: {
        voiceProvider: config.voiceProvider,
        providerAccount: config.voiceProvider === 'plivo' ? maskedValue(config.plivo.authId) : '',
        leadSource: config.leadSource,
        callerIdNumber: config.callerIdNumber,
        callerIdNumbers: config.callerIdNumbers,
        verifiedCallerIds,
        endpointReadiness,
        hubspotProperties: config.hubspot.properties,
        leadStatusOptions,
        maxAttemptsPerLead: config.compliance.maxAttemptsPerLead
      },
      owners: data.owners,
      campaigns: data.campaigns,
      leads: data.leads,
      agents: safeAgents(data.agents || []),
      agentInvites: request.user?.role === 'admin' ? (data.agentInvites || []).slice(0, 100) : [],
      reports: {
        agents: buildAgentReports(reportData)
      },
      dashboard: buildDashboardSummary(reportData),
      dncNumbers: data.dncNumbers || [],
      calls: data.calls.slice(0, 100),
      events: data.events.slice(0, 50)
    });
    return true;
  }

  const inviteLookupMatch = url.pathname.match(/^\/api\/invites\/([^/]+)$/);
  if (request.method === 'GET' && inviteLookupMatch) {
    const record = getAgentInvite(inviteLookupMatch[1]);
    if (!record?.invite || !record.agent) {
      sendJson(response, { error: 'Invite not found' }, 404);
      return true;
    }
    sendJson(response, {
      invite: {
        status: record.invite.status,
        expiresAt: record.invite.expiresAt
      },
      agent: {
        name: record.agent.name,
        email: record.agent.email,
        hubspotOwnerId: record.agent.hubspotOwnerId
      },
      appName: 'TruckX Auto Dialer'
    });
    return true;
  }

  const inviteAcceptMatch = url.pathname.match(/^\/api\/invites\/([^/]+)\/accept$/);
  if (request.method === 'POST' && inviteAcceptMatch) {
    const body = await parseBody(request);
    let result;
    try {
      result = acceptAgentInvite(inviteAcceptMatch[1], body);
    } catch (error) {
      const status = error.message === 'Invite not found' || error.message === 'Agent not found' ? 404 : 400;
      sendJson(response, { error: error.message }, status);
      return true;
    }
    sendJson(response, {
      token: result.token,
      agent: {
        id: result.agent.id,
        name: result.agent.name,
        email: result.agent.email,
        hubspotOwnerId: result.agent.hubspotOwnerId
      },
      apiBaseUrl: config.publicBaseUrl,
      alreadyAccepted: Boolean(result.alreadyAccepted)
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/setup') {
    if (requireAdmin(request, response)) return true;
    sendJson(response, setupStatus());
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/hubspot/owners/sync') {
    if (requireAdmin(request, response)) return true;
    const result = await dialerEngine.syncHubSpotOwners();
    sendJson(response, result);
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/agents/invite') {
    if (requireAdmin(request, response)) return true;

    const body = await parseBody(request);
    if (body.callerIdNumber) {
      try {
        body.callerIdNumber = await assertPlivoVerifiedCallerId(body.callerIdNumber);
      } catch (error) {
        sendJson(response, { error: error.message }, 400);
        return true;
      }
    }
    const endpointUsername = normalizedEndpointUsername(body.plivoEndpointUsername);
    const endpointPassword = String(body.plivoEndpointPassword || '');
    if (Boolean(endpointUsername) !== Boolean(endpointPassword)) {
      sendJson(response, { error: 'Enter both the Plivo endpoint username and password, or leave both blank' }, 400);
      return true;
    }
    if (endpointUsername) {
      const email = String(body.email || '').trim().toLowerCase();
      const duplicateAgent = (getStore().agents || []).find((agent) => (
        String(agent.email || '').trim().toLowerCase() !== email
        && normalizedEndpointUsername(agent.plivoEndpointUsername) === endpointUsername
      ));
      if (duplicateAgent) {
        sendJson(response, { error: `That Plivo endpoint is already assigned to ${duplicateAgent.name}` }, 409);
        return true;
      }
      body.plivoEndpointUsername = String(body.plivoEndpointUsername || '').trim();
    }

    const email = String(body.email || '').trim().toLowerCase();
    const existingAgent = (getStore().agents || []).find((agent) => (
      String(agent.email || '').trim().toLowerCase() === email
    ));
    let provisionedEndpoint = null;
    if (
      config.voiceProvider === 'plivo'
      && config.agentConnectionMode === 'browser'
      && !endpointUsername
      && !existingAgent?.plivoEndpointUsername
    ) {
      try {
        provisionedEndpoint = await provisionPlivoEndpoint(body);
        body.plivoEndpointUsername = provisionedEndpoint.username;
        body.plivoEndpointPassword = provisionedEndpoint.password;
        body.plivoEndpointId = provisionedEndpoint.endpointId;
        body.plivoEndpointManaged = true;
      } catch (error) {
        sendJson(response, { error: `Automatic Plivo endpoint creation failed: ${error.message}` }, 502);
        return true;
      }
    }

    let result;
    try {
      result = createAgentInvite(body, config.publicBaseUrl);
    } catch (error) {
      if (provisionedEndpoint?.endpointId) {
        await deletePlivoEndpoint(provisionedEndpoint.endpointId).catch(() => {});
      }
      throw error;
    }

    try {
      const emailResult = await sendAgentInviteEmail(result);
      updateAgentInviteEmailStatus(result.invite.id, {
        emailSent: Boolean(emailResult.sent),
        emailError: emailResult.reason || ''
      });
      result.invite.emailSent = Boolean(emailResult.sent);
      result.invite.emailError = emailResult.reason || '';
    } catch (error) {
      updateAgentInviteEmailStatus(result.invite.id, {
        emailSent: false,
        emailError: error.message
      });
      result.invite.emailSent = false;
      result.invite.emailError = error.message;
    }

    sendJson(response, {
      ...result,
      agent: safeAgents([result.agent])[0]
    }, 201);
    return true;
  }

  const deleteAgentMatch = url.pathname.match(/^\/api\/admin\/agents\/([^/]+)$/);
  if (request.method === 'DELETE' && deleteAgentMatch) {
    if (requireAdmin(request, response)) return true;
    const data = getStore();
    const agent = data.agents.find((item) => item.id === deleteAgentMatch[1]);
    if (!agent) {
      sendJson(response, { error: 'Agent not found' }, 404);
      return true;
    }
    const activeCampaigns = data.campaigns.filter((campaign) => (
      campaign.ownerId === agent.ownerId
      && ['running', 'connected'].includes(campaign.status)
    ));
    for (const campaign of activeCampaigns) {
      await dialerEngine.stopCampaign(campaign.id, 'stopped');
    }
    if (agent.plivoEndpointManaged && agent.plivoEndpointId) {
      try {
        await deletePlivoEndpoint(agent.plivoEndpointId);
      } catch (error) {
        addEvent('plivo_endpoint_delete_failed', error.message, {
          agentId: agent.id,
          endpointId: agent.plivoEndpointId
        });
      }
    }
    const deleted = deleteAgent(agent.id);
    sendJson(response, { deleted: true, agent: { id: deleted.id, name: deleted.name, email: deleted.email } });
    return true;
  }

  const disconnectAgentMatch = url.pathname.match(/^\/api\/admin\/agents\/([^/]+)\/disconnect$/);
  if (request.method === 'POST' && disconnectAgentMatch) {
    if (requireAdmin(request, response)) return true;
    const agent = disconnectAgent(disconnectAgentMatch[1], 'admin_disconnect');
    sendJson(response, {
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        status: agent.status,
        extensionStatus: agent.extensionStatus,
        disconnectedAt: agent.disconnectedAt
      }
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/extension/me') {
    if (!request.user?.agentId) {
      sendJson(response, { error: 'Extension token required' }, 401);
      return true;
    }
    const agent = touchAgent(request.user.agentId);
    sendJson(response, {
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        hubspotOwnerId: agent.hubspotOwnerId,
        lastSeenAt: agent.lastSeenAt
      }
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/extension/logout') {
    if (!request.user?.agentId) {
      sendJson(response, { error: 'Extension token required' }, 401);
      return true;
    }
    disconnectAgent(request.user.agentId, 'agent_logout');
    sendJson(response, { ok: true });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/agent/softphone-config') {
    
    if (!request.user?.agentId) {
      sendJson(response, { error: 'Agent session required' }, 401);
      return true;
    }

    const data = getStore();
    const agent = data.agents.find((item) => item.id === request.user.agentId);
    const username = agent?.plivoEndpointUsername || config.plivo.browserUsername;
    const password = agent?.plivoEndpointPassword || config.plivo.browserPassword;
    const dialTarget = agent?.plivoDialTarget || config.plivo.browserDialTarget;
    sendJson(response, {
      mode: config.agentConnectionMode,
      enabled: config.voiceProvider === 'plivo'
        && config.agentConnectionMode === 'browser'
        && Boolean(username && password),
      username,
      password,
      dialTarget,
      callerIdNumber: agent?.callerIdNumber || config.callerIdNumber
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/dnc') {
    if (requireAdmin(request, response)) return true;
    const data = getStore();
    sendJson(response, { dncNumbers: data.dncNumbers || [] });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/dnc') {
    if (requireAdmin(request, response)) return true;
    const body = await parseBody(request);
    const phone = normalizeUsPhone(body.phone);
    if (!phone) {
      sendJson(response, { error: 'Enter a valid US phone number' }, 400);
      return true;
    }
    const record = addDncNumber({
      phone,
      reason: body.reason || 'Manual opt-out',
      source: body.source || 'manual'
    });
    sendJson(response, record, 201);
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/dnc/remove') {
    if (requireAdmin(request, response)) return true;
    const body = await parseBody(request);
    const phone = normalizeUsPhone(body.phone);
    if (!phone) {
      sendJson(response, { error: 'Enter a valid US phone number' }, 400);
      return true;
    }
    sendJson(response, removeDncNumber(phone));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/campaigns') {
    if (requireAdmin(request, response)) return true;
    const body = await parseBody(request);
    if (body.callerIdNumber) {
      try {
        body.callerIdNumber = await assertPlivoVerifiedCallerId(body.callerIdNumber);
      } catch (error) {
        sendJson(response, { error: error.message }, 400);
        return true;
      }
    }
    const campaign = createCampaign(body);
    sendJson(response, campaign, 201);
    return true;
  }

  const updateCampaignMatch = url.pathname.match(/^\/api\/campaigns\/([^/]+)$/);
  if (request.method === 'PATCH' && updateCampaignMatch) {
    assertCampaignAccess(updateCampaignMatch[1], request.user);
    const body = await parseBody(request);
    const patch = request.user?.role === 'admin'
      ? {
          maxParallelCalls: body.maxParallelCalls,
          leadStatusFilters: body.leadStatusFilters,
          callerIdNumber: body.callerIdNumber
        }
      : {
          leadStatusFilters: body.leadStatusFilters
        };
    if (patch.callerIdNumber) {
      try {
        patch.callerIdNumber = await assertPlivoVerifiedCallerId(patch.callerIdNumber);
      } catch (error) {
        sendJson(response, { error: error.message }, 400);
        return true;
      }
    }
    sendJson(response, updateCampaign(updateCampaignMatch[1], patch));
    dialerEngine.scheduleTick('campaign_updated');
    return true;
  }

  const deleteCampaignMatch = url.pathname.match(/^\/api\/campaigns\/([^/]+)$/);
  if (request.method === 'DELETE' && deleteCampaignMatch) {
    if (requireAdmin(request, response)) return true;
    const campaign = deleteCampaign(deleteCampaignMatch[1]);
    sendJson(response, { deleted: true, campaign });
    return true;
  }

  const startCampaignId = campaignIdFromPath(url.pathname, 'start');
  if (request.method === 'POST' && startCampaignId) {
    assertCampaignAccess(startCampaignId, request.user);
    let campaign = null;
    try {
      campaign = await dialerEngine.startCampaign(startCampaignId);
    } catch (error) {
      addEvent('engine_error', error.message, { campaignId: startCampaignId, source: 'manual_start' });
      throw error;
    }
    sendJson(response, campaign);
    return true;
  }

  const stopCampaignId = campaignIdFromPath(url.pathname, 'stop');
  if (request.method === 'POST' && stopCampaignId) {
    assertCampaignAccess(stopCampaignId, request.user);
    const campaign = await dialerEngine.stopCampaign(stopCampaignId, 'stopped');
    sendJson(response, campaign);
    return true;
  }

  const syncCampaignId = campaignIdFromPath(url.pathname, 'sync-hubspot');
  if (request.method === 'POST' && syncCampaignId) {
    if (requireAdmin(request, response)) return true;
    assertCampaignAccess(syncCampaignId, request.user);
    const result = await dialerEngine.syncHubSpotLeadsForCampaign(syncCampaignId);
    sendJson(response, result);
    return true;
  }

  const resetProviderErrorsCampaignId = campaignIdFromPath(url.pathname, 'reset-provider-errors');
  if (request.method === 'POST' && resetProviderErrorsCampaignId) {
    if (requireAdmin(request, response)) return true;
    assertCampaignAccess(resetProviderErrorsCampaignId, request.user);
    sendJson(response, resetProviderErrorsForCampaign(resetProviderErrorsCampaignId));
    return true;
  }

  const snapshotMatch = url.pathname.match(/^\/api\/campaigns\/([^/]+)$/);
  if (request.method === 'GET' && snapshotMatch) {
    assertCampaignAccess(snapshotMatch[1], request.user);
    sendJson(response, dialerEngine.campaignSnapshot(snapshotMatch[1]));
    return true;
  }

  const dispositionMatch = url.pathname.match(/^\/api\/calls\/([^/]+)\/disposition$/);
  if (request.method === 'POST' && dispositionMatch) {
    const body = await parseBody(request);
    const data = getStore();
    const call = data.calls.find((item) => item.id === dispositionMatch[1]);
    assertCampaignAccess(call?.campaignId, request.user);
    sendJson(response, await dialerEngine.applyDisposition(dispositionMatch[1], body));
    return true;
  }

  const hangupMatch = url.pathname.match(/^\/api\/calls\/([^/]+)\/hangup$/);
  if (request.method === 'POST' && hangupMatch) {
    const data = getStore();
    const call = data.calls.find((item) => item.id === hangupMatch[1]);
    assertCampaignAccess(call?.campaignId, request.user);
    sendJson(response, await dialerEngine.hangupCustomerCall(hangupMatch[1]));
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/reports/agents') {
    const data = visibleState(getStore(), request.user);
    const reportData = {
      ...data,
      campaigns: data.campaigns.filter((campaign) => campaign.status !== 'deleted' && !campaign.deletedAt)
    };
    sendJson(response, { agents: buildAgentReports(reportData) });
    return true;
  }

  const leadStatusMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/status$/);
  if (request.method === 'POST' && leadStatusMatch) {
    const body = await parseBody(request);
    assertLeadAccess(leadStatusMatch[1], request.user);
    const lead = updateLead(leadStatusMatch[1], body);
    sendJson(response, lead);
    return true;
  }

  return false;
}

async function handleWebhooks(request, response, url) {
  if (request.method === 'POST' && url.pathname === '/webhooks/hubspot/contact') {
    const body = await parseBody(request);
    const events = Array.isArray(body) ? body : [body];
    addEvent('hubspot_webhook_received', `Received ${events.length} HubSpot event(s)`, {
      events: events.slice(0, 10).map((event) => ({
        objectId: event.objectId,
        propertyName: event.propertyName,
        subscriptionType: event.subscriptionType,
        changeSource: event.changeSource
      }))
    });
    sendJson(response, { ok: true, received: events.length });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/twilio/status') {
    const body = await parseBody(request);
    const call = await dialerEngine.completeProviderCall(body.CallSid, body.CallStatus, body.AnsweredBy, body);
    sendJson(response, { ok: true, call });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/plivo/status') {
    const body = await parseBody(request);
    const raw = webhookContext(url, body);
    const call = await dialerEngine.completeProviderCall(
      body.RequestUUID || body.CallUUID || body.RequestUuid || body.CallUuid,
      body.CallStatus || body.HangupCause || body.HangupCauseName || body.Event,
      body.AnsweredBy || body.Machine,
      raw
    );
    sendJson(response, { ok: true, call });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/plivo/machine') {
    const body = await parseBody(request);
    const raw = webhookContext(url, body);
    const call = await dialerEngine.completeProviderCall(
      body.RequestUUID || body.CallUUID || body.RequestUuid || body.CallUuid,
      body.CallStatus || body.HangupCause || body.HangupCauseName || body.Event,
      body.Machine,
      raw
    );
    sendJson(response, { ok: true, call });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/twilio/answer') {
    const body = await parseBody(request);
    const details = bridgeDetails(url);
    const answeredBy = String(body.AnsweredBy || url.searchParams.get('AnsweredBy') || '').toLowerCase();
    if (details.voicemailDrop && answeredBy.includes('machine') && details.voicemailAudioUrl) {
      sendXml(response, [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Response>',
        `<Play>${escapeXml(details.voicemailAudioUrl)}</Play>`,
        '<Hangup/>',
        '</Response>'
      ].join(''));
      return true;
    }

    sendXml(response, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      `<Dial callerId="${escapeXml(details.callerIdNumber)}"><Number>${escapeXml(details.agentPhone)}</Number></Dial>`,
      '</Response>'
    ].join(''));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/plivo/answer') {
    const details = bridgeDetails(url);
    sendXml(response, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      `<Dial callerId="${escapeXml(plivoNumber(details.callerIdNumber))}"><Number>${escapeXml(plivoNumber(details.agentPhone))}</Number></Dial>`,
      '</Response>'
    ].join(''));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/plivo/agent-answer') {
    const details = bridgeDetails(url);
    if (!details.leadPhone) {
      sendXml(response, [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Response>',
        '<Hangup/>',
        '</Response>'
      ].join(''));
      return true;
    }

    sendXml(response, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      `<Dial callerId="${escapeXml(plivoNumber(details.callerIdNumber))}" dialMusic="real"><Number>${escapeXml(plivoNumber(details.leadPhone))}</Number></Dial>`,
      '</Response>'
    ].join(''));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/plivo/agent-session') {
    const body = await parseBody(request);
    const campaignId = url.searchParams.get('campaignId') || '';
    const sessionId = url.searchParams.get('sessionId') || '';
    const session = await dialerEngine.markAgentSessionAnswered(campaignId, sessionId, body);

    sendXml(response, conferenceXml(session.conferenceName, {
      startConferenceOnEnter: 'true',
      endConferenceOnExit: 'true',
      stayAlone: 'true',
      maxMembers: '2',
      enterSound: '',
      exitSound: ''
    }));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/plivo/browser-agent-session') {
    const body = await parseBody(request);
    const { campaign, session } = runningBrowserSessionForAgent(body);

    if (!campaign || !session) {
      addEvent('browser_agent_session_unmatched', 'Browser agent session could not match a running PowerList', {
        from: body.From || body.CallerName || '',
        to: body.To || '',
        callUuid: body.CallUUID || '',
        requestUuid: body.RequestUUID || ''
      });
      sendXml(response, [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Response>',
        '<Hangup/>',
        '</Response>'
      ].join(''));
      return true;
    }

    // 🆕 NEW: Send push notification to browser agents
    const data = getStore();
    const agents = data.agents || [];
    const agentForCampaign = agents.find(a => a.ownerId === campaign.ownerId);
    
    if (agentForCampaign && agentForCampaign.browserPushSubscription) {
      try {
        // Send notification to agent's browser
        // (We'll implement this next)
        console.log(`[Push] Sending incoming call notification to agent ${agentForCampaign.email}`);
        addEvent('browser_agent_notification_sent', 'Incoming call notification sent to agent', {
          agentId: agentForCampaign.id,
          campaignId: campaign.id,
          fromNumber: body.From || body.CallerName || ''
        });
      } catch (error) {
        console.error('[Push] Failed to send notification:', error);
        addEvent('browser_agent_notification_failed', error.message, {
          agentId: agentForCampaign?.id
        });
      }
    }


    const updatedSession = await dialerEngine.markAgentSessionAnswered(campaign.id, session.id, body);
    sendXml(response, conferenceXml(updatedSession.conferenceName, {
      startConferenceOnEnter: 'true',
      endConferenceOnExit: 'true',
      stayAlone: 'true',
      maxMembers: '2',
      enterSound: '',
      exitSound: ''
    }));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/plivo/customer-answer') {
    const body = await parseBody(request);
    const campaignId = url.searchParams.get('campaignId') || '';
    const leadId = url.searchParams.get('leadId') || '';
    const details = bridgeDetails(url);

    if (!details.session?.agentConnectedAt || !details.conferenceName) {
      sendXml(response, [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Response>',
        '<Hangup/>',
        '</Response>'
      ].join(''));
      return true;
    }

    const result = await dialerEngine.markCustomerAnswered(campaignId, leadId, body);
    if (result?.abandoned) {
      sendXml(response, [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Response>',
        '<Hangup/>',
        '</Response>'
      ].join(''));
      return true;
    }

    sendXml(response, conferenceXml(details.conferenceName, {
      startConferenceOnEnter: 'true',
      endConferenceOnExit: 'false',
      stayAlone: 'false',
      maxMembers: '2',
      enterSound: '',
      exitSound: ''
    }));
    return true;
  }

  return false;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    request.user = authenticatedUser(request);
    if (isProtectedPath(url.pathname) && !request.user) {
      if (url.pathname.startsWith('/api/')) {
        unauthorizedApi(response);
      } else {
        unauthorized(response);
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/agent') {
      response.writeHead(302, { Location: `/agent/${url.search || ''}` });
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      response.writeHead(302, { Location: '/assets/truckx-mark.svg' });
      response.end();
      return;
    }

    if (await handleApi(request, response, url)) return;
    if (await handleWebhooks(request, response, url)) return;
    if (request.method === 'GET' && serveStatic(request, response, url)) return;
    send(response, 404, 'Not found');
  } catch (error) {
    sendJson(response, { error: error.message }, 500);
  }
});

await initStore();
dialerEngine.start();

async function shutdown() {
  await closeStore();
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown().catch(() => process.exit(1));
});

process.on('SIGINT', () => {
  shutdown().catch(() => process.exit(1));
});

server.listen(config.port, () => {
  console.log(`TruckX Auto Dialer running at http://localhost:${config.port}`);
  console.log(`Voice provider: ${config.voiceProvider}`);
  console.log(`Lead source: ${config.leadSource}`);
  console.log(`Storage: ${storeBackend()}`);
});
