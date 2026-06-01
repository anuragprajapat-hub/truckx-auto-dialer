import { config } from '../config.js';

function assertTwilioConfig() {
  if (!config.twilio.accountSid || !config.twilio.authToken) {
    throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
  }
}

function authHeader() {
  const token = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
  return `Basic ${token}`;
}

export function createTwilioProvider() {
  return {
    name: 'twilio',
    async createOutboundCall({ lead, campaign, callerIdNumber }) {
      assertTwilioConfig();

      const params = new URLSearchParams({
        To: lead.phone,
        From: callerIdNumber || config.callerIdNumber,
        Url: `${config.publicBaseUrl}/webhooks/twilio/answer?campaignId=${encodeURIComponent(campaign.id)}&leadId=${encodeURIComponent(lead.id)}`,
        Method: 'POST',
        StatusCallback: `${config.publicBaseUrl}/webhooks/twilio/status`,
        StatusCallbackMethod: 'POST',
        StatusCallbackEvent: 'initiated ringing answered completed',
        MachineDetection: 'Enable'
      });

      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Calls.json`, {
        method: 'POST',
        headers: {
          Authorization: authHeader(),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      });

      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.message || `Twilio call failed with ${response.status}`);
      }

      return {
        providerCallId: body.sid,
        provider: 'twilio',
        status: body.status || 'queued',
        agentPhone: campaign.agentPhone,
        leadPhone: lead.phone,
        callerIdNumber: callerIdNumber || config.callerIdNumber
      };
    },
    async cancelOutboundCall(call) {
      assertTwilioConfig();
      if (!call.providerCallId) return { skipped: true };

      const params = new URLSearchParams({
        Status: call.status === 'in_progress' ? 'completed' : 'canceled'
      });

      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Calls/${encodeURIComponent(call.providerCallId)}.json`, {
        method: 'POST',
        headers: {
          Authorization: authHeader(),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      });

      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.message || `Twilio cancel failed with ${response.status}`);
      }

      return body;
    },
    resolveOutcome() {
      return null;
    }
  };
}
