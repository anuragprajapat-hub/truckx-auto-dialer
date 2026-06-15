import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const originalCwd = process.cwd();
const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'truckx-dialer-test-'));
process.chdir(testCwd);

const contacts = Array.from({ length: 1250 }, (_, index) => ({
  id: String(index + 1),
  properties: {
    firstname: `Contact ${index + 1}`,
    lastname: 'Test',
    phone: '+12125550100',
    hs_lead_status: 'NEW'
  }
}));

const requests = [];
let verifiedCallerIdRecords = [];
const hubspotServer = http.createServer(async (request, response) => {
  let rawBody = '';
  for await (const chunk of request) rawBody += chunk;
  const body = rawBody ? JSON.parse(rawBody) : {};
  requests.push({ method: request.method, url: request.url, body });

  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'POST' && request.url === '/crm/v3/objects/contacts/search') {
    const offset = Number(body.after || 0);
    const page = contacts.slice(offset, offset + Number(body.limit || 200));
    const nextOffset = offset + page.length;
    response.end(JSON.stringify({
      total: contacts.length,
      results: page,
      paging: nextOffset < contacts.length
        ? { next: { after: String(nextOffset) } }
        : undefined
    }));
    return;
  }

  if (request.method === 'PATCH' && request.url === '/crm/v3/objects/contacts/123') {
    const properties = body.properties || {};
    if (Object.keys(properties).length > 1) {
      response.statusCode = 400;
      response.end(JSON.stringify({ message: 'Property values were not valid' }));
      return;
    }
    if (Object.hasOwn(properties, 'hs_lead_status')) {
      response.end(JSON.stringify({ id: '123', properties }));
      return;
    }
    response.statusCode = 400;
    response.end(JSON.stringify({
      message: 'Property does not exist',
      errors: [{ error: 'PROPERTY_DOESNT_EXIST' }]
    }));
    return;
  }

  if (request.method === 'POST' && request.url === '/v1/Account/test-auth/Call/live-123/DTMF/') {
    response.end(JSON.stringify({ message: 'digits sent' }));
    return;
  }

  if (request.method === 'GET' && request.url.startsWith('/v1/Account/test-auth/VerifiedCallerId/')) {
    response.end(JSON.stringify({
      objects: verifiedCallerIdRecords,
      meta: { total_count: verifiedCallerIdRecords.length }
    }));
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ message: 'Not found' }));
});

await new Promise((resolve) => hubspotServer.listen(0, '127.0.0.1', resolve));
const address = hubspotServer.address();
process.env.HUBSPOT_API_BASE_URL = `http://127.0.0.1:${address.port}`;
process.env.HUBSPOT_PRIVATE_APP_TOKEN = 'test-token';
process.env.LEAD_SOURCE = 'hubspot';
process.env.VOICE_PROVIDER = 'mock';

const hubspot = await import('../src/hubspot.js');
const { config } = await import('../src/config.js');
const store = await import('../src/store.js');
const { DialerEngine } = await import('../src/dialerEngine.js');
const { createPlivoProvider } = await import('../src/voice/plivoProvider.js');

await store.initStore();

after(async () => {
  await store.closeStore();
  await new Promise((resolve) => hubspotServer.close(resolve));
  process.chdir(originalCwd);
  fs.rmSync(testCwd, { recursive: true, force: true });
});

test('HubSpot owner sync pages through every contact without a 1,000-contact cap', async () => {
  const leads = await hubspot.fetchContactsForOwner({
    id: 'owner-test',
    hubspotOwnerId: '42'
  });

  assert.equal(leads.length, 1250);
  const searchRequests = requests.filter((item) => item.url === '/crm/v3/objects/contacts/search');
  assert.equal(searchRequests.length, 7);
  assert.deepEqual(searchRequests.map((item) => item.body.limit), [200, 200, 200, 200, 200, 200, 200]);
});

test('missing optional HubSpot properties do not turn a successful status update into an error', async () => {
  const result = await hubspot.updateHubSpotLead(
    { hubspotId: '123' },
    { status: 'FOLLOWUP', lastOutcome: 'FOLLOWUP', attempts: 2 }
  );

  assert.equal(result.partial, false);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.skippedProperties.sort(), ['dialer_attempts', 'last_call_outcome']);
  assert.equal(result.results.hs_lead_status.properties.hs_lead_status, 'FOLLOWUP');
});

test('returning a connected campaign to running preserves its active audio session', () => {
  const campaign = store.createCampaign({
    ownerId: 'owner_demo_1',
    name: 'Session reuse',
    maxParallelCalls: 1
  });
  const running = store.setCampaignStatus(campaign.id, 'running');
  const sessionId = running.currentSessionId;

  store.updateStore((data) => {
    data.campaigns.find((item) => item.id === campaign.id).status = 'connected';
  });
  const resumed = store.setCampaignStatus(campaign.id, 'running');

  assert.equal(resumed.currentSessionId, sessionId);
  assert.equal(store.getStore().sessions.filter((item) => item.campaignId === campaign.id).length, 1);
});

test('PowerList Lines can be updated after creation', () => {
  const campaign = store.createCampaign({
    ownerId: 'owner_demo_1',
    name: 'Editable lines',
    maxParallelCalls: 1
  });

  const updated = store.updateCampaign(campaign.id, { maxParallelCalls: 4 });
  assert.equal(updated.maxParallelCalls, 4);
  assert.equal(store.getStore().campaigns.find((item) => item.id === campaign.id).maxParallelCalls, 4);
});

test('a newly verified Plivo caller ID refreshes automatically after a cache miss', async () => {
  const previous = {
    voiceProvider: config.voiceProvider,
    apiBaseUrl: config.plivo.apiBaseUrl,
    authId: config.plivo.authId,
    authToken: config.plivo.authToken
  };
  config.voiceProvider = 'plivo';
  config.plivo.apiBaseUrl = `http://127.0.0.1:${address.port}`;
  config.plivo.authId = 'test-auth';
  config.plivo.authToken = 'test-token';
  verifiedCallerIdRecords = [
    { phone_number: '+16505550101', alias: 'First', country: 'US' }
  ];

  try {
    const callerIds = await import('../src/voice/plivoCallerIds.js');
    const initial = await callerIds.fetchPlivoVerifiedCallerIds({ refresh: true });
    assert.equal(initial.callerIds.length, 1);

    verifiedCallerIdRecords.push({
      phone_number: '+16505550102',
      alias: 'New agent',
      country: 'US'
    });
    const cached = await callerIds.fetchPlivoVerifiedCallerIds();
    assert.equal(cached.callerIds.length, 1);

    const verified = await callerIds.assertPlivoVerifiedCallerId('+16505550102');
    assert.equal(verified, '+16505550102');
    const refreshed = await callerIds.fetchPlivoVerifiedCallerIds();
    assert.equal(refreshed.callerIds.length, 2);
  } finally {
    config.voiceProvider = previous.voiceProvider;
    config.plivo.apiBaseUrl = previous.apiBaseUrl;
    config.plivo.authId = previous.authId;
    config.plivo.authToken = previous.authToken;
    verifiedCallerIdRecords = [];
  }
});

test('voicemail resumes the campaign queue automatically', async () => {
  const campaign = store.createCampaign({
    ownerId: 'owner_demo_1',
    name: 'Voicemail resume',
    maxParallelCalls: 1
  });
  const running = store.setCampaignStatus(campaign.id, 'running');
  store.updateStore((data) => {
    data.campaigns.find((item) => item.id === campaign.id).status = 'connected';
  });
  store.updateLead('lead_001', { attempts: 1, status: 'dialing' });
  const call = store.addCall({
    campaignId: campaign.id,
    sessionId: running.currentSessionId,
    leadId: 'lead_001',
    leadName: 'Avery Johnson',
    leadPhone: '+12125550112',
    attempt: 1,
    providerCallId: 'vm-request',
    status: 'in_progress'
  });

  const engine = new DialerEngine();
  let scheduledReason = '';
  engine.scheduleTick = (reason) => {
    scheduledReason = reason;
  };
  await engine.completeCall(call, 'voicemail', { Machine: 'true' });

  assert.equal(store.getStore().campaigns.find((item) => item.id === campaign.id).status, 'running');
  assert.equal(store.getStore().leads.find((item) => item.id === 'lead_001').status, 'voicemail');
  assert.equal(scheduledReason, 'call_completed_voicemail');
});

test('saving a live-call disposition restarts a paused campaign', async () => {
  const campaign = store.createCampaign({
    ownerId: 'owner_demo_1',
    name: 'Disposition resume',
    maxParallelCalls: 1
  });
  const running = store.setCampaignStatus(campaign.id, 'running');
  const call = store.addCall({
    campaignId: campaign.id,
    sessionId: running.currentSessionId,
    leadId: 'lead_002',
    leadName: 'Morgan Lee',
    leadPhone: '+13125550144',
    attempt: 1,
    status: 'completed',
    completedAt: new Date().toISOString(),
    outcome: 'live_answer',
    requiresDisposition: true
  });
  store.setCampaignStatus(campaign.id, 'paused');

  const engine = new DialerEngine();
  let scheduledReason = '';
  engine.scheduleTick = (reason) => {
    scheduledReason = reason;
  };
  await engine.applyDisposition(call.id, { status: 'FOLLOWUP', note: 'Call back tomorrow' });

  assert.equal(store.getStore().campaigns.find((item) => item.id === campaign.id).status, 'running');
  assert.equal(scheduledReason, 'disposition_saved');
});

test('a late machine callback corrects live answer to voicemail and resumes dialing', async () => {
  const campaign = store.createCampaign({
    ownerId: 'owner_demo_1',
    name: 'Late machine result',
    maxParallelCalls: 1
  });
  const running = store.setCampaignStatus(campaign.id, 'running');
  store.updateLead('lead_003', { attempts: 1, status: 'connected' });
  const call = store.addCall({
    campaignId: campaign.id,
    sessionId: running.currentSessionId,
    leadId: 'lead_003',
    leadName: 'Casey Rivera',
    leadPhone: '+14085550177',
    attempt: 1,
    providerCallId: 'late-machine-request',
    status: 'completed',
    completedAt: new Date().toISOString(),
    outcome: 'live_answer',
    requiresDisposition: true
  });

  const engine = new DialerEngine();
  let scheduledReason = '';
  engine.scheduleTick = (reason) => {
    scheduledReason = reason;
  };
  const corrected = await engine.completeProviderCall(
    call.providerCallId,
    'completed',
    'machine',
    { Machine: 'true' }
  );

  assert.equal(corrected.outcome, 'voicemail');
  assert.equal(corrected.requiresDisposition, false);
  assert.equal(scheduledReason, 'call_completed_voicemail');
});

test('manual dialing uses an active agent audio session', async () => {
  const campaign = store.createCampaign({
    ownerId: 'owner_demo_1',
    name: 'Manual dial',
    maxParallelCalls: 1
  });
  const running = store.setCampaignStatus(campaign.id, 'running');
  store.updateSession(running.currentSessionId, {
    agentConnectedAt: new Date().toISOString(),
    agentCallStatus: 'in_progress'
  });

  const engine = new DialerEngine();
  const call = await engine.manualDial(campaign.id, { phone: '+12125550999' });

  assert.equal(call.leadPhone, '+12125550999');
  assert.equal(call.campaignId, campaign.id);
  assert.equal(call.status, 'dialing');
});

test('connected-call keypad sends DTMF to the active Plivo call leg', async () => {
  config.plivo.apiBaseUrl = process.env.HUBSPOT_API_BASE_URL;
  config.plivo.authId = 'test-auth';
  config.plivo.authToken = 'test-token';
  const provider = createPlivoProvider();

  const result = await provider.sendDigits({
    providerCallId: 'request-123',
    providerLiveCallId: 'live-123'
  }, '#');

  assert.equal(result.message, 'digits sent');
  const dtmfRequest = requests.find((item) => item.url === '/v1/Account/test-auth/Call/live-123/DTMF/');
  assert.deepEqual(dtmfRequest.body, {
    digits: '#',
    leg: 'aleg'
  });
});
