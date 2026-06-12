import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

const CACHE_MS = 1000 * 60;
let endpointCache = {
  expiresAt: 0,
  endpoints: null
};

function assertPlivoConfig() {
  if (!config.plivo.authId || !config.plivo.authToken) {
    throw new Error('Missing PLIVO_AUTH_ID or PLIVO_AUTH_TOKEN');
  }
}

function authHeader() {
  const token = Buffer.from(`${config.plivo.authId}:${config.plivo.authToken}`).toString('base64');
  return `Basic ${token}`;
}

function normalizedUsername(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^sip:/, '')
    .split('@')[0];
}

function applicationIdFromUri(value) {
  if (value && typeof value === 'object') {
    return String(value.app_id || value.application_id || value.id || '');
  }
  return String(value || '').match(/\/Application\/([^/]+)\//)?.[1] || '';
}

function endpointAlias(name, email) {
  const source = String(name || email || 'TruckX Agent').trim();
  return source
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50) || 'TruckX_Agent';
}

function endpointUsername(name, email) {
  const source = String(name || email || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 12) || 'agent';
  return `truckx${source}${randomBytes(3).toString('hex')}`.slice(0, 30);
}

async function plivoEndpointRequest(path = '', options = {}) {
  assertPlivoConfig();
  const baseUrl = String(config.plivo.apiBaseUrl || '').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/v1/Account/${config.plivo.authId}/Endpoint/${path}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(10000),
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(result.error || result.message || `Plivo endpoint request failed with ${response.status}`);
  }
  return result;
}

export async function fetchPlivoEndpoints(options = {}) {
  if (!options.refresh && endpointCache.endpoints && endpointCache.expiresAt > Date.now()) {
    return endpointCache.endpoints;
  }

  const endpoints = [];
  for (let offset = 0; offset < 200; offset += 20) {
    const result = await plivoEndpointRequest(`?limit=20&offset=${offset}`);
    const records = result.objects || result.results || [];
    endpoints.push(...records.map((endpoint) => ({
      endpointId: String(endpoint.endpoint_id || endpoint.id || ''),
      username: String(endpoint.username || ''),
      alias: String(endpoint.alias || ''),
      sipUri: String(endpoint.sip_uri || ''),
      registered: String(endpoint.sip_registered || '').toLowerCase() === 'true',
      applicationId: applicationIdFromUri(endpoint.application)
    })));
    const totalCount = Number(result.meta?.total_count || endpoints.length);
    if (records.length < 20 || endpoints.length >= totalCount) break;
  }
  endpointCache = {
    expiresAt: Date.now() + CACHE_MS,
    endpoints
  };
  return endpoints;
}

export async function plivoEndpointReadiness() {
  if (config.voiceProvider !== 'plivo' || config.agentConnectionMode !== 'browser') {
    return {
      ready: true,
      endpointCount: 0,
      applicationId: '',
      templateUsername: ''
    };
  }

  const endpoints = await fetchPlivoEndpoints();
  const configuredUsername = normalizedUsername(config.plivo.browserUsername);
  const template = endpoints.find((endpoint) => normalizedUsername(endpoint.username) === configuredUsername);
  const applicationId = config.plivo.applicationId || template?.applicationId || '';
  return {
    ready: Boolean(applicationId),
    endpointCount: endpoints.length,
    applicationId,
    templateUsername: template?.username || ''
  };
}

export async function provisionPlivoEndpoint(input = {}) {
  const readiness = await plivoEndpointReadiness();
  if (!readiness.ready) {
    throw new Error('Cannot find the Plivo application attached to the current browser Endpoint. Set PLIVO_APPLICATION_ID in Render.');
  }

  const password = randomBytes(18).toString('hex');
  const username = endpointUsername(input.name, input.email);
  const result = await plivoEndpointRequest('', {
    method: 'POST',
    body: JSON.stringify({
      username,
      password,
      alias: endpointAlias(input.name, input.email),
      app_id: readiness.applicationId
    })
  });
  endpointCache = { expiresAt: 0, endpoints: null };

  return {
    endpointId: String(result.endpoint_id || ''),
    username: String(result.username || username),
    password,
    applicationId: readiness.applicationId,
    managed: true
  };
}

export async function deletePlivoEndpoint(endpointId) {
  if (!endpointId) return { skipped: true };
  const result = await plivoEndpointRequest(`${encodeURIComponent(endpointId)}/`, {
    method: 'DELETE'
  });
  endpointCache = { expiresAt: 0, endpoints: null };
  return result;
}
