import { config } from './config.js';
import { evaluateLeadForDial } from './compliance.js';
import {
  addCall,
  addEvent,
  getStore,
  resetProviderErrorsForCampaign,
  setCampaignStatus,
  updateSession,
  updateCall,
  updateLead,
  upsertLeads,
  upsertOwners
} from './store.js';
import { createHubSpotCallLog, fetchContactsForOwner, fetchHubSpotOwners, updateHubSpotLead } from './hubspot.js';
import { matchesCampaignTimeZone } from './timeZones.js';
import { createVoiceProvider } from './voice/index.js';
import { selectCallerIdNumber } from './voice/callerId.js';

const ACTIVE_STATUSES = new Set(['dialing', 'queued', 'ringing', 'in_progress']);
const CANCELABLE_STATUSES = new Set(['dialing', 'queued', 'ringing', 'in_progress']);
const SESSION_ACTIVE_STATUSES = new Set(['dialing', 'queued', 'ringing', 'in_progress']);

function conferenceNameFor(campaignId, sessionId) {
  return `truckx-${String(campaignId || '').slice(0, 8)}-${String(sessionId || '').slice(0, 8)}`;
}

function outcomeToLeadStatus(outcome, attempts = 0) {
  if (outcome === 'live_answer') return 'connected';
  if (outcome === 'voicemail') return 'voicemail';
  if (attempts >= config.compliance.maxAttemptsPerLead) return 'exhausted';
  if (outcome === 'no_answer') return 'no_answer';
  if (outcome === 'busy') return 'retry';
  return 'retry';
}

function providerStatusToOutcome(status, answeredBy) {
  const normalizedStatus = String(status || '').toLowerCase();
  const normalizedAnsweredBy = String(answeredBy || '').toLowerCase();

  if (normalizedAnsweredBy.includes('machine')) return 'voicemail';
  if (normalizedAnsweredBy.includes('human')) return 'live_answer';
  if (normalizedStatus === 'busy') return 'busy';
  if (normalizedStatus === 'no-answer' || normalizedStatus === 'no_answer' || normalizedStatus === 'timeout') return 'no_answer';
  if (normalizedStatus === 'failed' || normalizedStatus === 'canceled' || normalizedStatus === 'cancel') return 'failed';
  if (normalizedStatus === 'completed') return 'live_answer';
  return '';
}

function providerStatusIsLive(status, answeredBy) {
  const normalizedStatus = String(status || '').toLowerCase();
  const normalizedAnsweredBy = String(answeredBy || '').toLowerCase();
  if (normalizedAnsweredBy.includes('machine')) return false;
  if (normalizedAnsweredBy.includes('human')) return true;
  return ['answered', 'in-progress', 'in_progress'].includes(normalizedStatus);
}

export class DialerEngine {
  constructor() {
    this.voiceProvider = createVoiceProvider();
    this.timer = null;
    this.isTicking = false;
  }

  usesPersistentAgentSession() {
    return typeof this.voiceProvider.createAgentSession === 'function';
  }

  async startCampaign(campaignId) {
    const campaign = setCampaignStatus(campaignId, 'running');
    await this.tick();
    return getStore().campaigns.find((item) => item.id === campaign.id) || campaign;
  }

  async stopCampaign(campaignId, status = 'stopped', options = {}) {
    const data = getStore();
    const campaign = data.campaigns.find((item) => item.id === campaignId);
    if (!campaign) throw new Error('Campaign not found');

    const activeCalls = data.calls.filter((call) => (
      call.campaignId === campaign.id && CANCELABLE_STATUSES.has(call.status)
    ));

    for (const call of activeCalls) {
      try {
        if (call.providerCallId !== options.skipProviderCallId && typeof this.voiceProvider.cancelOutboundCall === 'function') {
          await this.voiceProvider.cancelOutboundCall(call);
        }
      } catch (error) {
        addEvent('call_cancel_failed', error.message, {
          campaignId: call.campaignId,
          callId: call.id
        });
      }

      updateCall(call.id, {
        status: 'canceled',
        completedAt: new Date().toISOString(),
        outcome: status === 'complete' ? 'campaign_complete' : 'campaign_stopped'
      });
      updateLead(call.leadId, {
        status: 'retry',
        lastOutcome: status === 'complete' ? 'campaign_complete' : 'campaign_stopped'
      });
    }

    const session = data.sessions.find((item) => item.id === campaign.currentSessionId);
    if (session?.agentCallId && session.agentCallId !== options.skipProviderCallId) {
      try {
        if (typeof this.voiceProvider.cancelOutboundCall === 'function') {
          await this.voiceProvider.cancelOutboundCall({
            providerCallId: session.agentCallId,
            providerLiveCallId: session.agentLiveCallId,
            status: session.agentCallStatus
          });
        }
      } catch (error) {
        addEvent('agent_session_cancel_failed', error.message, {
          campaignId: campaign.id,
          sessionId: session.id
        });
      }
    }

    const ended = setCampaignStatus(campaign.id, status);
    addEvent('campaign_session_ended', `Campaign ${campaign.name} ${status}`, {
      campaignId: campaign.id,
      status
    });
    return ended;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        addEvent('engine_error', error.message);
      });
    }, 2000);
  }

  async syncHubSpotLeadsForCampaign(campaignId) {
    if (config.leadSource !== 'hubspot') {
      return { skipped: true, reason: 'LEAD_SOURCE is not hubspot' };
    }

    const data = getStore();
    const campaign = data.campaigns.find((item) => item.id === campaignId);
    if (!campaign) throw new Error('Campaign not found');

    const owner = data.owners.find((item) => item.id === campaign.ownerId);
    if (!owner) throw new Error('Owner not found');

    const leads = await fetchContactsForOwner(owner);
    const count = upsertLeads(leads);
    const reset = resetProviderErrorsForCampaign(campaignId);
    addEvent('hubspot_sync', `Synced ${count} HubSpot contacts`, { campaignId, providerErrorsReset: reset.reset });
    return { count, providerErrorsReset: reset.reset };
  }

  async syncHubSpotOwners() {
    if (config.leadSource !== 'hubspot') {
      return { skipped: true, reason: 'LEAD_SOURCE is not hubspot' };
    }

    const owners = await fetchHubSpotOwners();
    const count = upsertOwners(owners);
    addEvent('hubspot_owner_sync', `Synced ${count} HubSpot owners`);
    return { count };
  }

  async tick() {
    if (this.isTicking) return;
    this.isTicking = true;

    try {
      await this.completeMockCalls();
      await this.startDueCalls();
    } finally {
      this.isTicking = false;
    }
  }

  async completeMockCalls() {
    if (this.voiceProvider.name !== 'mock') return;

    const data = getStore();
    const activeCalls = data.calls.filter((call) => ACTIVE_STATUSES.has(call.status));
    for (const call of activeCalls) {
      const outcome = this.voiceProvider.resolveOutcome(call);
      if (!outcome) continue;
      await this.completeCall(call, outcome, { source: 'mock' });
    }
  }

  async startDueCalls() {
    const data = getStore();
    const runningCampaigns = data.campaigns.filter((campaign) => campaign.status === 'running');

    for (const runningCampaign of runningCampaigns) {
      const fresh = getStore();
      const campaign = fresh.campaigns.find((item) => item.id === runningCampaign.id);
      if (!campaign) continue;

      if (this.usesPersistentAgentSession()) {
        const agentReady = await this.ensureAgentSession(campaign);
        if (!agentReady) continue;
      }

      const activeCalls = fresh.calls.filter((call) => call.campaignId === campaign.id && ACTIVE_STATUSES.has(call.status));
      const maxParallelCalls = this.usesPersistentAgentSession() ? 1 : Number(campaign.maxParallelCalls || 1);
      const openSlots = Math.max(0, maxParallelCalls - activeCalls.length);
      if (!openSlots) continue;

      const dncNumbers = new Set((fresh.dncNumbers || []).map((item) => item.phone));
      const activeLeadIds = new Set(activeCalls.map((call) => call.leadId));
      const sessionLeadIds = new Set(fresh.calls
        .filter((call) => call.campaignId === campaign.id && call.sessionId === campaign.currentSessionId)
        .map((call) => call.leadId));
      const leads = fresh.leads
        .filter((lead) => lead.ownerId === campaign.ownerId)
        .filter((lead) => matchesCampaignTimeZone(lead, campaign))
        .filter((lead) => !activeLeadIds.has(lead.id))
        .filter((lead) => !sessionLeadIds.has(lead.id))
        .filter((lead) => evaluateLeadForDial(lead, campaign, { dncNumbers }).allowed)
        .slice(0, openSlots);

      if (!leads.length && activeCalls.length === 0) {
        const anyCandidate = fresh.leads.some((lead) => (
          lead.ownerId === campaign.ownerId
          && matchesCampaignTimeZone(lead, campaign)
          && !sessionLeadIds.has(lead.id)
        ));
        if (!anyCandidate) {
          await this.stopCampaign(campaign.id, 'complete');
          addEvent('campaign_complete', `Campaign ${campaign.name} completed`, { campaignId: campaign.id });
        }
        continue;
      }

      for (const lead of leads) {
        await this.startCall(campaign, lead);
      }
    }
  }

  async ensureAgentSession(campaign) {
    const data = getStore();
    const latestCampaign = data.campaigns.find((item) => item.id === campaign.id);
    const session = data.sessions.find((item) => item.id === latestCampaign?.currentSessionId);
    if (!latestCampaign?.currentSessionId || !session) {
      return false;
    }

    if (session.agentConnectedAt) {
      return true;
    }

    if (session.agentCallId && SESSION_ACTIVE_STATUSES.has(session.agentCallStatus || 'queued')) {
      return false;
    }

    const conferenceName = session.conferenceName || conferenceNameFor(latestCampaign.id, session.id);
    const callerIdNumber = selectCallerIdNumber({ phone: latestCampaign.agentPhone }, latestCampaign, 1);
    try {
      const providerSession = await this.voiceProvider.createAgentSession({
        campaign: latestCampaign,
        session,
        callerIdNumber,
        conferenceName
      });

      updateSession(session.id, {
        agentCallId: providerSession.providerCallId,
        agentCallStatus: providerSession.status || 'queued',
        conferenceName
      });

      addEvent('agent_session_started', `Calling agent for ${latestCampaign.name}`, {
        campaignId: latestCampaign.id,
        sessionId: session.id,
        providerCallId: providerSession.providerCallId,
        conferenceName
      });
    } catch (error) {
      updateSession(session.id, {
        agentCallStatus: 'failed',
        agentError: error.message
      });
      addEvent('agent_session_failed', error.message, {
        campaignId: latestCampaign.id,
        sessionId: session.id
      });
      await this.stopCampaign(latestCampaign.id, 'stopped');
    }

    return false;
  }

  async startCall(campaign, lead) {
    const data = getStore();
    const dncNumbers = new Set((data.dncNumbers || []).map((item) => item.phone));
    const allowed = evaluateLeadForDial(lead, campaign, { dncNumbers });
    if (!allowed.allowed) {
      addEvent('lead_skipped', allowed.reason, { campaignId: campaign.id, leadId: lead.id });
      return;
    }

    const attempt = Number(lead.attempts || 0) + 1;
    const dialLead = {
      ...lead,
      phone: allowed.phone,
      attempts: attempt,
      status: 'dialing'
    };

    try {
      const callerIdNumber = selectCallerIdNumber(dialLead, campaign, attempt);
      const providerCall = await this.voiceProvider.createOutboundCall({
        lead: dialLead,
        campaign,
        callerIdNumber
      });

      addEvent('provider_call_accepted', `${providerCall.provider} accepted call request for ${lead.name}`, {
        campaignId: campaign.id,
        leadId: lead.id,
        provider: providerCall.provider,
        providerCallId: providerCall.providerCallId,
        leadPhone: allowed.phone,
        callerIdNumber
      });

      updateLead(lead.id, {
        phone: allowed.phone,
        attempts: attempt,
        status: 'dialing',
        lastProviderError: ''
      });

      const call = addCall({
        campaignId: campaign.id,
        sessionId: campaign.currentSessionId || '',
        leadId: lead.id,
        leadName: lead.name,
        leadPhone: allowed.phone,
        ownerId: campaign.ownerId,
        attempt,
        status: providerCall.status || 'dialing',
        provider: providerCall.provider,
        providerCallId: providerCall.providerCallId,
        agentPhone: providerCall.agentPhone,
        callerIdNumber: providerCall.callerIdNumber || callerIdNumber
      });

      addEvent('call_started', `Dialing ${lead.name}`, {
        campaignId: campaign.id,
        callId: call.id,
        provider: providerCall.provider
      });
    } catch (error) {
      updateLead(lead.id, {
        phone: allowed.phone,
        status: 'provider_error',
        lastOutcome: 'provider_error',
        lastProviderError: error.message
      });
      addEvent('call_failed_to_start', error.message, {
        campaignId: campaign.id,
        leadId: lead.id
      });
    }
  }

  async completeCall(call, outcome, raw = {}) {
    const completedAt = new Date().toISOString();
    const leadStatus = outcomeToLeadStatus(outcome, call.attempt);
    const requiresDisposition = outcome === 'live_answer';

    const updatedCall = updateCall(call.id, {
      status: 'completed',
      completedAt,
      outcome,
      requiresDisposition,
      raw
    });

    const data = getStore();
    const lead = data.leads.find((item) => item.id === call.leadId);
    if (lead) {
      const updatedLead = updateLead(lead.id, {
        status: leadStatus,
        lastOutcome: outcome
      });

      if (config.leadSource === 'hubspot') {
        try {
          await updateHubSpotLead(updatedLead, {
            status: leadStatus,
            lastOutcome: outcome,
            attempts: updatedLead.attempts
          });
          await createHubSpotCallLog(updatedCall, updatedLead, outcome);
        } catch (error) {
          addEvent('hubspot_write_failed', error.message, {
            campaignId: call.campaignId,
            callId: call.id,
            leadId: lead.id
          });
        }
      }
    }

    addEvent('call_completed', `${call.leadName} ended as ${outcome}`, {
      campaignId: call.campaignId,
      callId: call.id,
      outcome
    });

    const campaign = getStore().campaigns.find((item) => item.id === updatedCall.campaignId);
    if (outcome === 'live_answer' && this.usesPersistentAgentSession(campaign)) {
      await this.cancelCompetingCalls(updatedCall);
    } else if (outcome === 'live_answer') {
      await this.pauseCampaignForLiveAnswer(updatedCall);
    }

    return updatedCall;
  }

  async markCustomerAnswered(campaignId, leadId, raw = {}) {
    const data = getStore();
    const call = data.calls.find((item) => item.campaignId === campaignId && item.leadId === leadId && !item.completedAt);
    if (!call) return null;

    const updatedCall = updateCall(call.id, {
      status: 'in_progress',
      answeredAt: new Date().toISOString(),
      providerLiveCallId: raw.CallUUID || call.providerLiveCallId || '',
      raw
    });

    addEvent('customer_joined_agent_session', `${call.leadName} answered and joined the agent session`, {
      campaignId,
      callId: call.id,
      leadId
    });

    return updatedCall;
  }

  async markAgentSessionAnswered(campaignId, sessionId, raw = {}) {
    const data = getStore();
    const campaign = data.campaigns.find((item) => item.id === campaignId);
    if (!campaign) throw new Error('Campaign not found');

    const session = data.sessions.find((item) => item.id === sessionId || item.id === campaign.currentSessionId);
    if (!session) throw new Error('Session not found');

    const conferenceName = session.conferenceName || conferenceNameFor(campaign.id, session.id);
    const updatedSession = updateSession(session.id, {
      agentCallStatus: 'in_progress',
      agentConnectedAt: session.agentConnectedAt || new Date().toISOString(),
      agentLiveCallId: raw.CallUUID || session.agentLiveCallId || '',
      conferenceName,
      rawAgentAnswer: raw
    });

    addEvent('agent_session_connected', `Agent connected for ${campaign.name}`, {
      campaignId: campaign.id,
      sessionId: session.id,
      conferenceName
    });

    return updatedSession;
  }

  async completeAgentSession(providerCallId, providerStatus, raw = {}) {
    const data = getStore();
    const session = data.sessions.find((item) => item.agentCallId === providerCallId || item.agentLiveCallId === providerCallId);
    if (!session) return null;

    updateSession(session.id, {
      agentCallStatus: providerStatus || 'completed',
      agentEndedAt: new Date().toISOString(),
      rawAgentHangup: raw
    });

    const campaign = getStore().campaigns.find((item) => item.id === session.campaignId);
    if (campaign && ['running', 'connected'].includes(campaign.status)) {
      await this.stopCampaign(campaign.id, 'stopped', { skipProviderCallId: providerCallId });
    }

    addEvent('agent_session_ended', `Agent session ended for ${campaign?.name || session.campaignId}`, {
      campaignId: session.campaignId,
      sessionId: session.id,
      providerCallId,
      providerStatus
    });

    return session;
  }

  async pauseCampaignForLiveAnswer(answeredCall) {
    await this.cancelCompetingCalls(answeredCall);

    const latest = getStore().campaigns.find((item) => item.id === answeredCall.campaignId);
    if (latest && ['running', 'connected'].includes(latest.status)) {
      setCampaignStatus(latest.id, 'paused');
      addEvent('campaign_paused_for_disposition', `Campaign paused after live answer from ${answeredCall.leadName}`, {
        campaignId: latest.id,
        callId: answeredCall.id
      });
    }
  }

  async cancelCompetingCalls(answeredCall) {
    const data = getStore();
    const campaign = data.campaigns.find((item) => item.id === answeredCall.campaignId);
    if (!campaign?.pauseOnLiveAnswer) return;

    const competingCalls = data.calls.filter((call) => (
      call.campaignId === answeredCall.campaignId
      && call.id !== answeredCall.id
      && CANCELABLE_STATUSES.has(call.status)
    ));

    for (const call of competingCalls) {
      try {
        if (typeof this.voiceProvider.cancelOutboundCall === 'function') {
          await this.voiceProvider.cancelOutboundCall(call);
        }
      } catch (error) {
        addEvent('call_cancel_failed', error.message, {
          campaignId: call.campaignId,
          callId: call.id
        });
      }

      updateCall(call.id, {
        status: 'canceled',
        completedAt: new Date().toISOString(),
        outcome: 'canceled_after_connect'
      });
      updateLead(call.leadId, {
        status: 'retry',
        lastOutcome: 'canceled_after_connect'
      });
      addEvent('call_canceled_after_connect', `${call.leadName} canceled after another live answer`, {
        campaignId: call.campaignId,
        callId: call.id
      });
    }
  }

  async applyDisposition(callId, input) {
    const data = getStore();
    const call = data.calls.find((item) => item.id === callId);
    if (!call) throw new Error('Call not found');

    const lead = data.leads.find((item) => item.id === call.leadId);
    if (!lead) throw new Error('Lead not found');

    const status = String(input.status || '').trim();
    if (!status) throw new Error('Lead status is required');

    const updatedCall = updateCall(call.id, {
      requiresDisposition: false,
      dispositionStatus: status,
      dispositionNote: String(input.note || '').trim(),
      dispositionAt: new Date().toISOString()
    });

    const updatedLead = updateLead(lead.id, {
      status,
      lastOutcome: call.outcome || lead.lastOutcome
    });

    if (config.leadSource === 'hubspot') {
      try {
        await updateHubSpotLead(updatedLead, {
          status,
          lastOutcome: updatedLead.lastOutcome,
          attempts: updatedLead.attempts
        });
      } catch (error) {
        addEvent('hubspot_disposition_failed', error.message, {
          campaignId: call.campaignId,
          callId: call.id,
          leadId: lead.id
        });
      }
    }

    addEvent('call_disposition_saved', `${call.leadName} set to ${status}`, {
      campaignId: call.campaignId,
      callId: call.id,
      leadId: lead.id
    });

    return { call: updatedCall, lead: updatedLead };
  }

  async completeProviderCall(providerCallId, providerStatus, answeredBy, raw = {}) {
    const data = getStore();
    const call = data.calls.find((item) => item.providerCallId === providerCallId || item.providerLiveCallId === providerCallId);
    if (!call) {
      const session = await this.completeAgentSession(providerCallId, providerStatus, raw);
      if (session) return session;

      addEvent('unknown_provider_call', `No local call matched provider id ${providerCallId}`, raw);
      return null;
    }

    const outcome = providerStatusToOutcome(providerStatus, answeredBy);
    if (!outcome) {
      updateCall(call.id, {
        status: providerStatus || call.status,
        raw
      });
      if (providerStatusIsLive(providerStatus, answeredBy)) {
        const latestCall = getStore().calls.find((item) => item.id === call.id);
        await this.cancelCompetingCalls(latestCall);
        const latestCampaign = getStore().campaigns.find((item) => item.id === call.campaignId);
        if (latestCampaign?.status === 'running' && !this.usesPersistentAgentSession(latestCampaign)) {
          setCampaignStatus(latestCampaign.id, 'connected');
        }
      }
      return call;
    }

    return this.completeCall(call, outcome, raw);
  }

  campaignSnapshot(campaignId) {
    const data = getStore();
    const campaign = data.campaigns.find((item) => item.id === campaignId);
    if (!campaign) throw new Error('Campaign not found');

    const leads = data.leads
      .filter((lead) => lead.ownerId === campaign.ownerId)
      .filter((lead) => matchesCampaignTimeZone(lead, campaign))
      .map((lead) => ({
        ...lead,
        dialCheck: evaluateLeadForDial(lead, campaign, {
          dncNumbers: new Set((data.dncNumbers || []).map((item) => item.phone))
        })
      }));

    const calls = data.calls.filter((call) => call.campaignId === campaign.id);

    return {
      campaign,
      leads,
      calls,
      activeCalls: calls.filter((call) => ACTIVE_STATUSES.has(call.status)),
      events: data.events.filter((event) => event.details?.campaignId === campaign.id).slice(0, 30)
    };
  }
}

export const dialerEngine = new DialerEngine();
