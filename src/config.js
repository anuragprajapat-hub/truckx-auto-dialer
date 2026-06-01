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

const callerIdNumbers = listFromEnv('CALLER_ID_NUMBERS');
if (process.env.CALLER_ID_NUMBER && !callerIdNumbers.includes(process.env.CALLER_ID_NUMBER)) {
  callerIdNumbers.unshift(process.env.CALLER_ID_NUMBER);
}

export const config = {
  port: numberFromEnv('PORT', 4242),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:4242',
  appAuth: {
    username: process.env.APP_USERNAME || 'admin',
    password: process.env.APP_PASSWORD || ''
  },
  leadSource: process.env.LEAD_SOURCE || 'mock',
  voiceProvider: process.env.VOICE_PROVIDER || 'mock',
  callerIdNumber: callerIdNumbers[0] || '+15551234567',
  callerIdNumbers: callerIdNumbers.length ? callerIdNumbers : ['+15551234567'],
  defaultAgentPhone: process.env.DEFAULT_AGENT_PHONE || '+15557654321',
  voicemailAudioUrl: process.env.VOICEMAIL_AUDIO_URL || '',
  hubspot: {
    privateAppToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN || '',
    properties: {
      consent: process.env.HUBSPOT_PROP_CONSENT || 'dialer_consent',
      doNotCall: process.env.HUBSPOT_PROP_DNC || 'do_not_call',
      attempts: process.env.HUBSPOT_PROP_ATTEMPTS || 'dialer_attempts',
      lastOutcome: process.env.HUBSPOT_PROP_LAST_OUTCOME || 'last_call_outcome',
      timeZone: process.env.HUBSPOT_PROP_TIME_ZONE || 'time_zone',
      leadStatus: process.env.HUBSPOT_PROP_LEAD_STATUS || 'hs_lead_status'
    }
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || ''
  },
  plivo: {
    authId: process.env.PLIVO_AUTH_ID || '',
    authToken: process.env.PLIVO_AUTH_TOKEN || ''
  },
  compliance: {
    defaultCallWindowStart: process.env.DEFAULT_CALL_WINDOW_START || '09:00',
    defaultCallWindowEnd: process.env.DEFAULT_CALL_WINDOW_END || '18:00',
    maxAttemptsPerLead: numberFromEnv('MAX_ATTEMPTS_PER_LEAD', 3),
    callableStatuses: listFromEnv('CALLABLE_LEAD_STATUSES').length
      ? listFromEnv('CALLABLE_LEAD_STATUSES').map((status) => status.toLowerCase())
      : ['new', 'retry', 'no_answer']
  }
};
