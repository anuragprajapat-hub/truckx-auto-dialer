import { config } from '../config.js';

function assertPlivoConfig() {
  if (!config.plivo.authId || !config.plivo.authToken) {
    throw new Error('Missing PLIVO_AUTH_ID or PLIVO_AUTH_TOKEN');
  }
}

function authHeader() {
  const token = Buffer.from(`${config.plivo.authId}:${config.plivo.authToken}`).toString('base64');
  return `Basic ${token}`;
}

function plivoNumber(phone) {
  return String(phone || '').replace(/^\+/, '');
}

function webhookUrl(path, params = {}) {
  const url = new URL(path, config.publicBaseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value)) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function createPlivoProvider() {
  return {
    name: 'plivo',
    async createAgentSession({ campaign, session, callerIdNumber, conferenceName }) {
      assertPlivoConfig();

      const body = {
        from: plivoNumber(callerIdNumber || config.callerIdNumber),
        to: plivoNumber(campaign.agentPhone),
        answer_url: webhookUrl('/webhooks/plivo/agent-session', {
          campaignId: campaign.id,
          sessionId: session.id,
          role: 'agent'
        }),
        answer_method: 'POST',
        hangup_url: webhookUrl('/webhooks/plivo/status', {
          campaignId: campaign.id,
          sessionId: session.id,
          role: 'agent'
        }),
        hangup_method: 'POST'
      };

      const response = await fetch(`${String(config.plivo.apiBaseUrl).replace(/\/$/, '')}/v1/Account/${config.plivo.authId}/Call/`, {
        method: 'POST',
        headers: {
          Authorization: authHeader(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || result.message || `Plivo agent call failed with ${response.status}`);
      }

      return {
        providerCallId: result.request_uuid || result.message_uuid?.[0] || '',
        provider: 'plivo',
        status: 'queued',
        agentPhone: campaign.agentPhone,
        callerIdNumber: callerIdNumber || config.callerIdNumber,
        conferenceName
      };
    },
    async createOutboundCall({ lead, campaign, callerIdNumber }) {
      assertPlivoConfig();

      const callbackContext = {
        campaignId: campaign.id,
        leadId: lead.id,
        sessionId: campaign.currentSessionId || '',
        role: 'customer'
      };
      const body = {
        from: plivoNumber(callerIdNumber || config.callerIdNumber),
        to: plivoNumber(lead.phone),
        answer_url: webhookUrl('/webhooks/plivo/customer-answer', callbackContext),
        answer_method: 'POST',
        hangup_url: webhookUrl('/webhooks/plivo/status', callbackContext),
        hangup_method: 'POST',
        ring_timeout: config.plivo.ringTimeoutSeconds
      };

      if (config.plivo.machineDetection) {
        body.machine_detection = config.plivo.machineDetection;
        body.machine_detection_time = config.plivo.machineDetectionTimeMs;
        body.machine_detection_url = webhookUrl('/webhooks/plivo/machine', callbackContext);
        body.machine_detection_method = 'POST';
      }

      const response = await fetch(`${String(config.plivo.apiBaseUrl).replace(/\/$/, '')}/v1/Account/${config.plivo.authId}/Call/`, {
        method: 'POST',
        headers: {
          Authorization: authHeader(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || result.message || `Plivo call failed with ${response.status}`);
      }

      return {
        providerCallId: result.request_uuid || result.message_uuid?.[0] || '',
        provider: 'plivo',
        status: 'queued',
        agentPhone: campaign.agentPhone,
        leadPhone: lead.phone,
        callerIdNumber: callerIdNumber || config.callerIdNumber
      };
    },
    async cancelOutboundCall(call) {
      assertPlivoConfig();
      const callId = call.providerLiveCallId || call.providerCallId;
      if (!callId) return { skipped: true };

      const response = await fetch(`${String(config.plivo.apiBaseUrl).replace(/\/$/, '')}/v1/Account/${config.plivo.authId}/Call/${encodeURIComponent(callId)}/`, {
        method: 'DELETE',
        headers: {
          Authorization: authHeader()
        }
      });

      const text = await response.text();
      const result = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(result.error || result.message || `Plivo cancel failed with ${response.status}`);
      }

      return result;
    },
    async sendDigits(call, digits) {
      assertPlivoConfig();
      const callId = call.providerLiveCallId || call.providerCallId;
      if (!callId) throw new Error('Active Plivo call ID is unavailable');

      const response = await fetch(`${String(config.plivo.apiBaseUrl).replace(/\/$/, '')}/v1/Account/${config.plivo.authId}/Call/${encodeURIComponent(callId)}/DTMF/`, {
        method: 'POST',
        headers: {
          Authorization: authHeader(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          digits,
          leg: 'aleg'
        })
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || result.message || `Plivo DTMF failed with ${response.status}`);
      }

      return result;
    },
    resolveOutcome() {
      return null;
    }
  };
}
