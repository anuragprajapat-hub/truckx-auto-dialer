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

export function createPlivoProvider() {
  return {
    name: 'plivo',
    async createOutboundCall({ lead, campaign, callerIdNumber }) {
      assertPlivoConfig();

      const body = {
        from: plivoNumber(callerIdNumber || config.callerIdNumber),
        to: plivoNumber(lead.phone),
        answer_url: `${config.publicBaseUrl}/webhooks/plivo/answer?campaignId=${encodeURIComponent(campaign.id)}&leadId=${encodeURIComponent(lead.id)}`,
        answer_method: 'POST',
        hangup_url: `${config.publicBaseUrl}/webhooks/plivo/status`,
        hangup_method: 'POST',
        machine_detection: 'true',
        machine_detection_url: `${config.publicBaseUrl}/webhooks/plivo/machine`,
        machine_detection_method: 'POST'
      };

      const response = await fetch(`https://api.plivo.com/v1/Account/${config.plivo.authId}/Call/`, {
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
      if (!call.providerCallId) return { skipped: true };

      const response = await fetch(`https://api.plivo.com/v1/Account/${config.plivo.authId}/Call/${encodeURIComponent(call.providerCallId)}/`, {
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
    resolveOutcome() {
      return null;
    }
  };
}
