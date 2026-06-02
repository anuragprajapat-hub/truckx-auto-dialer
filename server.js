import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { config } from './src/config.js';
import { normalizeUsPhone } from './src/compliance.js';
import { dialerEngine } from './src/dialerEngine.js';
import { sendAgentInviteEmail } from './src/email.js';
import { buildAgentReports } from './src/reports.js';
import {
  acceptAgentInvite,
  addDncNumber,
  addEvent,
  agentFromApiToken,
  createAgentInvite,
  createCampaign,
  getAgentInvite,
  getStore,
  removeDncNumber,
  setCampaignStatus,
  touchAgent,
  updateAgentInviteEmailStatus,
  updateLead
} from './src/store.js';

const publicDir = path.resolve(process.cwd(), 'public');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
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
  if (pathname.startsWith('/webhooks/')) return false;
  return true;
}

function unauthorized(response) {
  response.writeHead(401, {
    'Content-Type': 'text/plain; charset=utf-8',
    'WWW-Authenticate': 'Basic realm="Truckx Auto Dialer"'
  });
  response.end('Authentication required');
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

function setupStatus() {
  const publicUrl = config.publicBaseUrl || '';
  const isPublicWebhookUrl = publicUrl.startsWith('https://') && !publicUrl.includes('localhost') && !publicUrl.includes('127.0.0.1');
  const carrierReady = config.voiceProvider === 'mock'
    || (config.voiceProvider === 'twilio' && Boolean(config.twilio.accountSid && config.twilio.authToken))
    || (config.voiceProvider === 'plivo' && Boolean(config.plivo.authId && config.plivo.authToken));

  return {
    appName: 'Truckx Auto Dialer',
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
        message: carrierReady ? 'Ready' : 'Missing carrier credentials'
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
        label: 'Email invites',
        ok: Boolean(config.email.resendApiKey),
        value: config.email.resendApiKey ? 'Enabled' : 'Manual',
        message: config.email.resendApiKey ? 'Agent invitations will be emailed' : 'Set RESEND_API_KEY or copy invite links manually'
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
    .filter((campaign) => ownerIds.has(campaign.ownerId))
    .map((campaign) => campaign.id));

  if (user?.role === 'admin') {
    return data;
  }

  return {
    ...data,
    owners: data.owners.filter((owner) => ownerIds.has(owner.id)),
    campaigns: data.campaigns.filter((campaign) => campaignIds.has(campaign.id)),
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

function safeAgents(agents = []) {
  return agents.map(({ apiToken, ...agent }) => agent);
}

function bridgeDetails(url) {
  const campaignId = url.searchParams.get('campaignId') || '';
  const leadId = url.searchParams.get('leadId') || '';
  const data = getStore();
  const campaign = data.campaigns.find((item) => item.id === campaignId);
  const call = data.calls.find((item) => item.campaignId === campaignId && item.leadId === leadId && !item.completedAt);

  return {
    campaign,
    agentPhone: campaign?.agentPhone || call?.agentPhone || config.defaultAgentPhone,
    callerIdNumber: call?.callerIdNumber || config.callerIdNumber,
    voicemailDrop: Boolean(campaign?.voicemailDrop),
    voicemailAudioUrl: config.voicemailAudioUrl
  };
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
    sendJson(response, {
      ok: true,
      appName: 'Truckx Auto Dialer',
      provider: config.voiceProvider,
      leadSource: config.leadSource,
      time: new Date().toISOString()
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    const data = visibleState(getStore(), request.user);
    sendJson(response, {
      appName: 'Truckx Auto Dialer',
      currentUser: {
        username: request.user?.username || 'local',
        role: request.user?.role || 'admin',
        hubspotOwnerId: request.user?.hubspotOwnerId || ''
      },
      settings: {
        voiceProvider: config.voiceProvider,
        leadSource: config.leadSource,
        callerIdNumber: config.callerIdNumber,
        callerIdNumbers: config.callerIdNumbers,
        hubspotProperties: config.hubspot.properties,
        maxAttemptsPerLead: config.compliance.maxAttemptsPerLead
      },
      owners: data.owners,
      campaigns: data.campaigns,
      leads: data.leads,
      agents: safeAgents(data.agents || []),
      agentInvites: request.user?.role === 'admin' ? (data.agentInvites || []).slice(0, 100) : [],
      reports: {
        agents: buildAgentReports(data)
      },
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
      appName: 'Truckx Auto Dialer'
    });
    return true;
  }

  const inviteAcceptMatch = url.pathname.match(/^\/api\/invites\/([^/]+)\/accept$/);
  if (request.method === 'POST' && inviteAcceptMatch) {
    const body = await parseBody(request);
    const result = acceptAgentInvite(inviteAcceptMatch[1], body);
    sendJson(response, {
      token: result.token,
      agent: {
        id: result.agent.id,
        name: result.agent.name,
        email: result.agent.email,
        hubspotOwnerId: result.agent.hubspotOwnerId
      },
      apiBaseUrl: config.publicBaseUrl
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/setup') {
    sendJson(response, setupStatus());
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/hubspot/owners/sync') {
    const result = await dialerEngine.syncHubSpotOwners();
    sendJson(response, result);
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/agents/invite') {
    if (request.user?.role !== 'admin') {
      sendJson(response, { error: 'Admin access required' }, 403);
      return true;
    }

    const body = await parseBody(request);
    const result = createAgentInvite(body, config.publicBaseUrl);

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

    sendJson(response, result, 201);
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

  if (request.method === 'GET' && url.pathname === '/api/dnc') {
    const data = getStore();
    sendJson(response, { dncNumbers: data.dncNumbers || [] });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/dnc') {
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
    const body = await parseBody(request);
    if (request.user?.role === 'agent') {
      const data = getStore();
      const ownerIds = ownerIdsForUser(data, request.user);
      if (!ownerIds.has(body.ownerId)) {
        sendJson(response, { error: 'Agents can create campaigns only for their own HubSpot owner' }, 403);
        return true;
      }
    }
    const campaign = createCampaign(body);
    sendJson(response, campaign, 201);
    return true;
  }

  const startCampaignId = campaignIdFromPath(url.pathname, 'start');
  if (request.method === 'POST' && startCampaignId) {
    assertCampaignAccess(startCampaignId, request.user);
    const campaign = setCampaignStatus(startCampaignId, 'running');
    sendJson(response, campaign);
    return true;
  }

  const stopCampaignId = campaignIdFromPath(url.pathname, 'stop');
  if (request.method === 'POST' && stopCampaignId) {
    assertCampaignAccess(stopCampaignId, request.user);
    const campaign = setCampaignStatus(stopCampaignId, 'stopped');
    sendJson(response, campaign);
    return true;
  }

  const syncCampaignId = campaignIdFromPath(url.pathname, 'sync-hubspot');
  if (request.method === 'POST' && syncCampaignId) {
    assertCampaignAccess(syncCampaignId, request.user);
    const result = await dialerEngine.syncHubSpotLeadsForCampaign(syncCampaignId);
    sendJson(response, result);
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

  if (request.method === 'GET' && url.pathname === '/api/reports/agents') {
    const data = visibleState(getStore(), request.user);
    sendJson(response, { agents: buildAgentReports(data) });
    return true;
  }

  const leadStatusMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/status$/);
  if (request.method === 'POST' && leadStatusMatch) {
    const body = await parseBody(request);
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
    const call = await dialerEngine.completeProviderCall(body.CallUUID || body.RequestUUID, body.CallStatus || body.HangupCause, body.AnsweredBy, body);
    sendJson(response, { ok: true, call });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/plivo/machine') {
    const body = await parseBody(request);
    const call = await dialerEngine.completeProviderCall(body.CallUUID || body.RequestUUID, body.CallStatus, body.Machine, body);
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
      '<Say voice="alice">Please hold while we connect your call.</Say>',
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
      '<Speak>Please hold while we connect your call.</Speak>',
      `<Dial callerId="${escapeXml(details.callerIdNumber)}"><Number>${escapeXml(details.agentPhone)}</Number></Dial>`,
      '</Response>'
    ].join(''));
    return true;
  }

  return false;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    request.user = authenticatedUser(request);
    if (isProtectedPath(url.pathname) && !request.user) {
      unauthorized(response);
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

dialerEngine.start();

server.listen(config.port, () => {
  console.log(`Truckx Auto Dialer running at http://localhost:${config.port}`);
  console.log(`Voice provider: ${config.voiceProvider}`);
  console.log(`Lead source: ${config.leadSource}`);
});
