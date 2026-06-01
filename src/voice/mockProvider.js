import { randomUUID } from 'node:crypto';

const outcomes = ['live_answer', 'voicemail', 'no_answer', 'busy', 'failed'];

export function createMockProvider() {
  return {
    name: 'mock',
    async createOutboundCall({ lead, campaign, callerIdNumber }) {
      return {
        providerCallId: `mock_${randomUUID()}`,
        provider: 'mock',
        status: 'dialing',
        agentPhone: campaign.agentPhone,
        leadPhone: lead.phone,
        callerIdNumber
      };
    },
    resolveOutcome(call) {
      const ageMs = Date.now() - new Date(call.startedAt).getTime();
      if (ageMs < 5000) return null;

      const index = Math.abs([...call.leadId].reduce((sum, char) => sum + char.charCodeAt(0), 0) + call.attempt) % outcomes.length;
      return outcomes[index];
    },
    async cancelOutboundCall() {
      return { canceled: true };
    }
  };
}
