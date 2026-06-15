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
let unavailableSearchProperties = new Set();
const hubspotServer = http.createServer(async (request, response) => {
  let rawBody = '';
  for await (const chunk of request) rawBody += chunk;
  const body = rawBody ? JSON.parse(rawBody) : {};
  requests.push({ method: request.method, url: request.url, body });

  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'POST' && request.url === '/crm/v3/objects/contacts/search') {
    const unavailable = (body.properties || []).find((property) => (
      unavailableSearchProperties.has(property)
    ));
    if (unavailable) {
      response.statusCode = 400;
      response.end(JSON.stringify({ message: 'There was a problem with the request.' }));
      return;
    }
    const filters = (body.filterGroups || []).flatMap((group) => group.filters || []);
    const objectIdFilter = filters.find((filter) => filter.propertyName === 'hs_object_id');
    const afterObjectId = Number(objectIdFilter?.value || 0);
    const eligibleContacts = contacts.filter((contact) => Number(contact.id) > afterObjectId);
    const page = eligibleContacts.slice(0, Number(body.limit || 200));
    response.end(JSON.stringify({
      total: contacts.length,
      results: page,
      paging: page.length < eligibleContacts.length
        ? { next: { after: String(Number(page.at(-1)?.id || 0)) } }
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

test('persistent storage guard marks file storage as unavailable when required', () => {
  const original = process.env.REQUIRE_PERSISTENT_STORAGE;
  process.env.REQUIRE_PERSISTENT_STORAGE = 'true';
  try {
    assert.equal(store.persistentStorageRequired(), true);
    assert.deepEqual(store.storeDiagnostics(), {
      backend: 'file',
      required: true,
      persistent: false,
      ready: false,
      lastError: ''
    });
  } finally {
    if (original === undefined) {
      delete process.env.REQUIRE_PERSISTENT_STORAGE;
    } else {
      process.env.REQUIRE_PERSISTENT_STORAGE = original;
    }
  }
});

test('Render requires persistent storage even when the explicit guard is omitted', () => {
  const originalRequired = process.env.REQUIRE_PERSISTENT_STORAGE;
  const originalRender = process.env.RENDER;
  delete process.env.REQUIRE_PERSISTENT_STORAGE;
  process.env.RENDER = 'true';
  try {
    assert.equal(store.persistentStorageRequired(), true);
  } finally {
    if (originalRequired === undefined) {
      delete process.env.REQUIRE_PERSISTENT_STORAGE;
    } else {
      process.env.REQUIRE_PERSISTENT_STORAGE = originalRequired;
    }
    if (originalRender === undefined) {
      delete process.env.RENDER;
    } else {
      process.env.RENDER = originalRender;
    }
  }
});

test('Render Blueprint connects the service to persistent Postgres storage', () => {
  const blueprint = fs.readFileSync(path.join(originalCwd, 'render.yaml'), 'utf8');
  assert.match(blueprint, /key:\s*DATABASE_URL[\s\S]*fromDatabase:/);
  assert.match(blueprint, /key:\s*REQUIRE_PERSISTENT_STORAGE[\s\S]*value:\s*"true"/);
  assert.match(blueprint, /databases:[\s\S]*name:\s*truckx-auto-dialer-db/);
  assert.match(blueprint, /healthCheckPath:\s*\/api\/health/);
});

test('HubSpot owner sync keyset-pages through every contact without cursor caps', async () => {
  const leads = await hubspot.fetchContactsForOwner({
    id: 'owner-test',
    hubspotOwnerId: '42'
  });

  assert.equal(leads.length, 1250);
  const searchRequests = requests.filter((item) => item.url === '/crm/v3/objects/contacts/search');
  assert.equal(searchRequests.length, 7);
  assert.deepEqual(searchRequests.map((item) => item.body.limit), [200, 200, 200, 200, 200, 200, 200]);
  assert.ok(searchRequests.every((item) => !Object.hasOwn(item.body, 'after')));
  assert.ok(searchRequests.every((item) => item.body.sorts?.[0] === 'hs_object_id'));
  assert.deepEqual(
    searchRequests.slice(1).map((item) => (
      item.body.filterGroups[0].filters.find((filter) => filter.propertyName === 'hs_object_id')?.value
    )),
    ['200', '400', '600', '800', '1000', '1200']
  );
});

test('HubSpot contact sync skips unavailable optional properties instead of losing the owner leads', async () => {
  unavailableSearchProperties = new Set(['last_call_outcome', 'dialer_attempts']);
  try {
    const leads = await hubspot.fetchContactsForOwner({
      id: 'owner-missing-properties',
      hubspotOwnerId: '43'
    });

    assert.equal(leads.length, 1250);
    assert.deepEqual(leads.omittedProperties.sort(), ['dialer_attempts', 'last_call_outcome']);
    const successfulRequests = requests.filter((item) => (
      item.url === '/crm/v3/objects/contacts/search'
      && !(item.body.properties || []).some((property) => unavailableSearchProperties.has(property))
    ));
    assert.ok(successfulRequests.some((item) => item.body.limit === 200));
  } finally {
    unavailableSearchProperties = new Set();
  }
});

test('startup HubSpot recovery imports leads for existing empty PowerLists once per owner', async () => {
  store.updateStore((data) => {
    data.owners.push({
      id: 'owner-auto-sync',
      hubspotOwnerId: '44',
      name: 'Auto Sync Owner',
      email: 'auto-sync@example.com',
      agentPhone: '+16505550144'
    });
  });
  const campaign = store.createCampaign({
    ownerId: 'owner-auto-sync',
    name: 'Existing empty PowerList',
    maxParallelCalls: 1
  });

  const engine = new DialerEngine();
  const result = await engine.syncEmptyHubSpotCampaigns();
  const recovered = result.results.find((item) => item.campaignId === campaign.id);

  assert.equal(recovered.count, 1250);
  assert.equal(
    store.getStore().leads.filter((lead) => lead.ownerId === 'owner-auto-sync').length,
    1250
  );

  const snapshot = engine.campaignSnapshot(campaign.id, { page: 1, pageSize: 100 });
  assert.deepEqual(snapshot.summary, {
    total: 1250,
    ready: 1250,
    blocked: 0,
    topReason: '',
    topReasonCount: 0,
    hasProviderErrors: false
  });
  assert.equal(snapshot.leads.length, 100);
  assert.deepEqual(snapshot.pagination, {
    page: 1,
    pageSize: 100,
    pageCount: 13,
    total: 1250,
    start: 101,
    end: 200
  });

  const adminSnapshot = engine.campaignSnapshot(campaign.id, { includeLeads: false });
  assert.equal(adminSnapshot.leads.length, 0);
  assert.equal(adminSnapshot.summary.total, 1250);
  assert.equal(adminSnapshot.summary.ready, 1250);
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
