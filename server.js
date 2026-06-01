import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { config } from './src/config.js';
import { normalizeUsPhone } from './src/compliance.js';
import { dialerEngine } from './src/dialerEngine.js';
import { addDncNumber, addEvent, createCampaign, getStore, removeDncNumber, setCampaignStatus, updateLead } from './src/store.js';

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
  if (!config.appAuth.password) return false;
  if (pathname === '/api/health') return false;
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

function isAuthorized(request) {
  const header = request.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;

  try {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    const username = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);
    return username === config.appAuth.username && password === config.appAuth.password;
  } catch {
    return false;
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
        ok: Boolean(config.appAuth.password),
        value: config.appAuth.password ? 'Enabled' : 'Missing',
        message: config.appAuth.password ? 'UI and API are password protected' : 'Set APP_PASSWORD before using real leads'
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
        message: config.leadSource === 'hubspot' ? 'Private app token required' : 'Mock lead source'
      },
      {
        id: 'webhooks',
        label: 'Public webhooks',
        ok: config.voiceProvider === 'mock' || isPublicWebhookUrl,
        value: publicUrl,
        message: isPublicWebhookUrl ? 'Public HTTPS URL ready' : 'Needed for real carrier callbacks'
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
  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
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
    const data = getStore();
    sendJson(response, {
      appName: 'Truckx Auto Dialer',
      settings: {
        voiceProvider: config.voiceProvider,
        leadSource: config.leadSource,
        callerIdNumber: config.callerIdNumber,
        callerIdNumbers: config.callerIdNumbers,
        maxAttemptsPerLead: config.compliance.maxAttemptsPerLead
      },
      owners: data.owners,
      campaigns: data.campaigns,
      leads: data.leads,
      dncNumbers: data.dncNumbers || [],
      calls: data.calls.slice(0, 100),
      events: data.events.slice(0, 50)
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
    const campaign = createCampaign(body);
    sendJson(response, campaign, 201);
    return true;
  }

  const startCampaignId = campaignIdFromPath(url.pathname, 'start');
  if (request.method === 'POST' && startCampaignId) {
    const campaign = setCampaignStatus(startCampaignId, 'running');
    sendJson(response, campaign);
    return true;
  }

  const stopCampaignId = campaignIdFromPath(url.pathname, 'stop');
  if (request.method === 'POST' && stopCampaignId) {
    const campaign = setCampaignStatus(stopCampaignId, 'stopped');
    sendJson(response, campaign);
    return true;
  }

  const syncCampaignId = campaignIdFromPath(url.pathname, 'sync-hubspot');
  if (request.method === 'POST' && syncCampaignId) {
    const result = await dialerEngine.syncHubSpotLeadsForCampaign(syncCampaignId);
    sendJson(response, result);
    return true;
  }

  const snapshotMatch = url.pathname.match(/^\/api\/campaigns\/([^/]+)$/);
  if (request.method === 'GET' && snapshotMatch) {
    sendJson(response, dialerEngine.campaignSnapshot(snapshotMatch[1]));
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
    if (isProtectedPath(url.pathname) && !isAuthorized(request)) {
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
