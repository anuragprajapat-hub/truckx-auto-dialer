import fs from 'node:fs';
import path from 'node:path';

const envPath = path.resolve(process.cwd(), '.env');

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...valueParts] = trimmed.split('=');
    if (!process.env[key]) {
      process.env[key] = valueParts.join('=').trim();
    }
  }
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function listFromEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusMapFromEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...fallback, ...parsed };
    }
  } catch {
    // Also support compact env strings like follow_up:FOLLOWUP,new:NEW.
  }

  const pairs = Object.fromEntries(raw
    .split(',')
    .map((pair) => pair.split(':').map((part) => part.trim()))
    .filter(([key, value]) => key && value));
  return { ...fallback, ...pairs };
}

function usersFromEnv() {
  return listFromEnv('APP_USERS')
    .map((item) => {
      const [username, password, role = 'agent', hubspotOwnerId = ''] = item.split(':').map((part) => part.trim());
      if (!username || !password) return null;
      return {
        username,
        password,
        role: role === 'admin' ? 'admin' : 'agent',
        hubspotOwnerId
      };
    })
    .filter(Boolean);
}

const callerIdNumbers = listFromEnv('CALLER_ID_NUMBERS');
if (process.env.CALLER_ID_NUMBER && !callerIdNumbers.includes(process.env.CALLER_ID_NUMBER)) {
  callerIdNumbers.unshift(process.env.CALLER_ID_NUMBER);
}

const configuredUsers = usersFromEnv();
const fallbackUsers = process.env.APP_PASSWORD
  ? [
      {
        username: process.env.APP_USERNAME || 'admin',
        password: process.env.APP_PASSWORD,
        role: 'admin',
        hubspotOwnerId: ''
      }
    ]
  : [];

const defaultHubSpotLeadStatusValues = {
  new: 'NEW',
  connected: 'CONNECTED',
  follow_up: 'FOLLOWUP',
  followup: 'FOLLOWUP',
  qualified: 'QUALIFIED',
  not_interested: 'NOT_INTERESTED',
  bad_timing: 'BAD_TIMING',
  do_not_call: 'DO_NOT_CALL',
  voicemail: 'VOICEMAIL',
  no_answer: 'NO_ANSWER',
  retry: 'RETRY',
  exhausted: 'EXHAUSTED',
  abandoned: 'ABANDONED',
  failed: 'FAILED'
};

const plivoMachineDetection = String(process.env.PLIVO_MACHINE_DETECTION || 'hangup').trim().toLowerCase();
const configuredCallableStatuses = listFromEnv('CALLABLE_LEAD_STATUSES').map((status) => status.toLowerCase());
const strictCallableStatuses = ['true', 'yes', '1'].includes(
  String(process.env.STRICT_CALLABLE_LEAD_STATUSES || '').trim().toLowerCase()
);
const callableStatuses = strictCallableStatuses ? configuredCallableStatuses : [];

export const config = {
  port: numberFromEnv('PORT', 4242),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:4242',
  appAuth: {
    username: process.env.APP_USERNAME || 'admin',
    password: process.env.APP_PASSWORD || '',
    users: configuredUsers.length ? configuredUsers : fallbackUsers
  },
  email: {
    resendApiKey: process.env.RESEND_API_KEY || '',
    from: process.env.INVITE_FROM_EMAIL || 'TruckX Auto Dialer <noreply@truckx.local>'
  },
  leadSource: process.env.LEAD_SOURCE || 'mock',
  voiceProvider: process.env.VOICE_PROVIDER || 'mock',
  agentConnectionMode: process.env.AGENT_CONNECTION_MODE || 'phone',
  callerIdNumber: callerIdNumbers[0] || '+15551234567',
  callerIdNumbers: callerIdNumbers.length ? callerIdNumbers : ['+15551234567'],
  defaultAgentPhone: process.env.DEFAULT_AGENT_PHONE || '+15557654321',
  voicemailAudioUrl: process.env.VOICEMAIL_AUDIO_URL || '',
  hubspot: {
    privateAppToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN || '',
    syncLimit: numberFromEnv('HUBSPOT_SYNC_LIMIT', 1000),
    properties: {
      consent: process.env.HUBSPOT_PROP_CONSENT || 'dialer_consent',
      doNotCall: process.env.HUBSPOT_PROP_DNC || 'do_not_call',
      attempts: process.env.HUBSPOT_PROP_ATTEMPTS || 'dialer_attempts',
      lastOutcome: process.env.HUBSPOT_PROP_LAST_OUTCOME || 'last_call_outcome',
      timeZone: process.env.HUBSPOT_PROP_TIME_ZONE || 'time_zone',
      leadStatus: process.env.HUBSPOT_PROP_LEAD_STATUS || 'hs_lead_status'
    },
    leadStatusValues: statusMapFromEnv('HUBSPOT_LEAD_STATUS_VALUES', defaultHubSpotLeadStatusValues)
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || ''
  },
  plivo: {
    apiBaseUrl: process.env.PLIVO_API_BASE_URL || 'https://api.plivo.com',
    authId: process.env.PLIVO_AUTH_ID || '',
    authToken: process.env.PLIVO_AUTH_TOKEN || '',
    browserUsername: process.env.PLIVO_BROWSER_USERNAME || '',
    browserPassword: process.env.PLIVO_BROWSER_PASSWORD || '',
    browserDialTarget: process.env.PLIVO_BROWSER_DIAL_TARGET || 'truckx-agent@phone.plivo.com',
    applicationId: process.env.PLIVO_APPLICATION_ID || '',
    ringTimeoutSeconds: Math.max(5, Math.min(120, numberFromEnv('PLIVO_RING_TIMEOUT_SECONDS', 25))),
    machineDetection: ['true', 'hangup'].includes(plivoMachineDetection) ? plivoMachineDetection : '',
    machineDetectionTimeMs: Math.max(2000, Math.min(10000, numberFromEnv('PLIVO_MACHINE_DETECTION_TIME_MS', 5000)))
  },
  compliance: {
    defaultCallWindowStart: process.env.DEFAULT_CALL_WINDOW_START || '09:00',
    defaultCallWindowEnd: process.env.DEFAULT_CALL_WINDOW_END || '18:00',
    maxAttemptsPerLead: numberFromEnv('MAX_ATTEMPTS_PER_LEAD', 3),
    callableStatuses
  }
};
