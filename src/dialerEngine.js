import { config } from './config.js';
import { evaluateLeadForDial, matchesCampaignLeadStatus, normalizeUsPhone } from './compliance.js';
import {
  addCall,
  addEvent,
  getStore,
  resetProviderErrorsForCampaign,
  setCampaignStatus,
  updateSession,
  updateCall,
  updateLead,
  upsertManualLead,
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
const LIVE_CALL_STATUSES = new Set(['in_progress']);

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

function isMachineAnswer(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized.includes('machine')
    || ['true', 'yes', '1', 'voicemail', 'answering_machine', 'amd'].includes(normalized);
}

function hasAnswerTime(raw = {}) {
  return Boolean(raw.AnswerTime || raw.answer_time || raw.answerTime);
}

function providerStatusToOutcome(status, answeredBy, raw = {}) {
  const normalizedStatus = String(status || '').toLowerCase();
  const normalizedAnsweredBy = String(answeredBy || '').toLowerCase();
  const hangupDetails = [
    raw.HangupCause,
    raw.HangupCauseName,
    raw.HangupSource,
    raw.Event,
    raw.machine_detection
  ].filter(Boolean).join(' ').toLowerCase();

  if (isMachineAnswer(answeredBy) || isMachineAnswer(raw.Machine) || isMachineAnswer(raw.machine_detection)) return 'voicemail';
  if (hangupDetails.includes('machine') || hangupDetails.includes('voicemail')) return 'voicemail';
  if (normalizedAnsweredBy.includes('human')) return 'live_answer';
  if (['busy', 'user_busy'].includes(normalizedStatus) || hangupDetails.includes('busy')) return 'busy';
  if (
    ['no-answer', 'no_answer', 'timeout', 'unanswered'].includes(normalizedStatus)
    || hangupDetails.includes('no answer')
    || hangupDetails.includes('no-answer')
    || hangupDetails.includes('timeout')
  ) {
    return 'no_answer';
  }
  if (['failed', 'canceled', 'cancel', 'rejected'].includes(normalizedStatus)) return 'failed';
  if (['completed', 'complete', 'hangup'].includes(normalizedStatus) && !hasAnswerTime(raw)) return 'no_answer';
  if (['completed', 'complete'].includes(normalizedStatus)) return 'live_answer';
  return '';
}

function isTerminalProviderStatus(status, raw = {}) {
  const normalizedStatus = String(status || '').toLowerCase();
  if ([
    'completed',
    'complete',
    'hangup',
    'normal_clearing',
    'normal clearing',
    'originator_cancel',
    'cancel',
    'canceled',
    'failed',
    'busy',
    'no-answer',
    'no_answer',
    'timeout'
  ].includes(normalizedStatus)) {
    return true;
  }
  return Boolean(raw.HangupCause || raw.HangupCauseName || raw.HangupSource);
}

function providerStatusIsLive(status, answeredBy) {
  const normalizedStatus = String(status || '').toLowerCase();
  const normalizedAnsweredBy = String(answeredBy || '').toLowerCase();
  if (isMachineAnswer(answeredBy)) return false;
  if (normalizedAnsweredBy.includes('human')) return true;
  return ['answered', 'in-progress', 'in_progress'].includes(normalizedStatus);
}

function campaignLineCount(campaign) {
  return Math.max(1, Math.min(10, Number(campaign?.maxParallelCalls || 1)));
}

export class DialerEngine {
  constructor() {
    this.voiceProvider = createVoiceProvider();
    this.timer = null;
    this.isTicking = false;
    this.queuedTick = null;
  }

  usesPersistentAgentSession() {
    return typeof this.voiceProvider.createAgentSession === 'function';
  }

  usesBrowserAgentSession() {
    return this.voiceProvider.name === 'plivo' && config.agentConnectionMode === 'browser';
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

  scheduleTick(reason = 'scheduled') {
    if (this.queuedTick) return;
    this.queuedTick = setTimeout(() => {
      this.queuedTick = null;
      this.tick().catch((error) => {
        addEvent('engine_error', error.message, { reason });
      });
    }, 0);
  }

  resumeCampaignQueue(campaignId, reason) {
    const campaign = getStore().campaigns.find((item) => item.id === campaignId);
    if (!campaign || !['running', 'connected', 'paused'].includes(campaign.status)) {
      return campaign || null;
    }

    const previousStatus = campaign.status;
    const resumed = previousStatus === 'running'
      ? campaign
      : setCampaignStatus(campaign.id, 'running');
    if (previousStatus !== 'running') {
      addEvent('campaign_resumed', `Campaign ${campaign.name} resumed automatically`, {
        campaignId: campaign.id,
        reason
      });
    }
    this.scheduleTick(reason);
    return resumed;
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
    const omittedProperties = leads.omittedProperties || [];
    addEvent('hubspot_sync', `Synced ${count} HubSpot contacts`, {
      campaignId,
      providerErrorsReset: reset.reset,
      omittedProperties
    });
    return {
      count,
      providerErrorsReset: reset.reset,
      omittedProperties
    };
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
      const waitingForDisposition = fresh.calls.some((call) => (
        call.campaignId === campaign.id
        && call.sessionId === campaign.currentSessionId
        && call.requiresDisposition
      ));
      const agentInConversation = activeCalls.some((call) => LIVE_CALL_STATUSES.has(call.status));
      if (waitingForDisposition || agentInConversation) continue;

      const maxParallelCalls = this.usesBrowserAgentSession()
        ? campaignLineCount(campaign)
        : this.usesPersistentAgentSession() ? 1 : campaignLineCount(campaign);
      const openSlots = Math.max(0, maxParallelCalls - activeCalls.length);
      if (!openSlots) continue;

      const dncNumbers = new Set((fresh.dncNumbers || []).map((item) => item.phone));
      const activeLeadIds = new Set(activeCalls.map((call) => call.leadId));
      const campaignLeadIds = new Set(fresh.calls
        .filter((call) => call.campaignId === campaign.id)
        .map((call) => call.leadId));
      const leads = fresh.leads
        .filter((lead) => lead.ownerId === campaign.ownerId)
        .filter((lead) => matchesCampaignTimeZone(lead, campaign))
        .filter((lead) => matchesCampaignLeadStatus(lead, campaign))
        .filter((lead) => !activeLeadIds.has(lead.id))
        .filter((lead) => !campaignLeadIds.has(lead.id))
        .filter((lead) => evaluateLeadForDial(lead, campaign, { dncNumbers }).allowed)
        .slice(0, openSlots);

      if (!leads.length && activeCalls.length === 0) continue;

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

    if (this.usesBrowserAgentSession()) {
      if (!session.conferenceName) {
        updateSession(session.id, {
          agentCallStatus: 'waiting_for_browser',
          conferenceName: conferenceNameFor(latestCampaign.id, session.id)
        });
      }
      return false;
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

  async startCall(campaign, lead, options = {}) {
    const data = getStore();
    const dncNumbers = new Set((data.dncNumbers || []).map((item) => item.phone));
    const normalizedPhone = normalizeUsPhone(lead.phone);
    const allowed = options.skipQueueChecks
      ? {
          allowed: Boolean(normalizedPhone)
            && !dncNumbers.has(normalizedPhone)
            && !lead.doNotCall
            && String(lead.status || '').toLowerCase() !== 'do_not_call',
          phone: normalizedPhone,
          reason: !normalizedPhone
            ? 'Invalid or non-US phone number'
            : dncNumbers.has(normalizedPhone)
                || lead.doNotCall
                || String(lead.status || '').toLowerCase() === 'do_not_call'
              ? 'Number is on the do not call list'
              : 'Allowed'
        }
      : evaluateLeadForDial(lead, campaign, { dncNumbers });
    if (!allowed.allowed) {
      addEvent('lead_skipped', allowed.reason, { campaignId: campaign.id, leadId: lead.id });
      if (options.throwOnError) throw new Error(allowed.reason);
      return null;
    }

    const attempt = Number(lead.attempts || 0) + 1;
    const dialLead = {
      ...lead,
      phone: allowed.phone,
      attempts: attempt,
      status: 'dialing'
    };

    try {
      const agent = data.agents.find((item) => (
        item.ownerId === campaign.ownerId
        || String(item.hubspotOwnerId || '') === String(campaign.hubspotOwnerId || '')
      ));
      const callerIdNumber = selectCallerIdNumber(dialLead, {
        ...campaign,
        callerIdNumber: campaign.callerIdNumber || agent?.callerIdNumber || ''
      }, attempt);
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
        leadEmail: lead.email || '',
        leadCompany: lead.company || '',
        leadStatusAtDial: lead.status || '',
        ownerId: campaign.ownerId,
        agentId: agent?.id || '',
        agentName: agent?.name || '',
        agentEmail: agent?.email || '',
        hubspotOwnerId: campaign.hubspotOwnerId || agent?.hubspotOwnerId || '',
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
      return call;
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
      if (options.throwOnError) throw error;
      return null;
    }
  }

  async manualDial(campaignId, input = {}) {
    const data = getStore();
    const campaign = data.campaigns.find((item) => item.id === campaignId);
    if (!campaign) throw new Error('Campaign not found');
    if (campaign.status !== 'running' || !campaign.currentSessionId) {
      throw new Error('Start the PowerList and connect agent audio before manual dialing');
    }

    const session = data.sessions.find((item) => item.id === campaign.currentSessionId && !item.endedAt);
    if (!session?.agentConnectedAt) {
      throw new Error('Connect agent audio before manual dialing');
    }

    const activeCall = data.calls.find((call) => (
      call.campaignId === campaign.id
      && (ACTIVE_STATUSES.has(call.status) || call.requiresDisposition)
    ));
    if (activeCall) {
      throw new Error('Finish the current call and save its outcome before manual dialing');
    }

    const phone = normalizeUsPhone(input.phone);
    if (!phone) throw new Error('Enter a valid US phone number');
    if ((data.dncNumbers || []).some((item) => item.phone === phone)) {
      throw new Error('Number is on the global DNC list');
    }

    const existingLead = data.leads.find((lead) => (
      lead.ownerId === campaign.ownerId
      && normalizeUsPhone(lead.phone) === phone
    ));
    const lead = existingLead || upsertManualLead({
      ownerId: campaign.ownerId,
      hubspotOwnerId: campaign.hubspotOwnerId,
      phone,
      name: String(input.name || '').trim() || phone,
      status: campaign.leadStatusFilters?.[0] || 'new'
    });
    setCampaignStatus(campaign.id, 'connected');
    let call = null;
    try {
      call = await this.startCall(campaign, lead, {
        skipQueueChecks: true,
        throwOnError: true
      });
    } catch (error) {
      this.resumeCampaignQueue(campaign.id, 'manual_dial_failed');
      throw error;
    }
    addEvent('manual_dial_started', `Agent manually dialed ${phone}`, {
      campaignId: campaign.id,
      callId: call.id,
      leadId: lead.id,
      phone
    });
    return call;
  }

  async sendCallDigits(callId, input = {}) {
    const digits = String(input.digits || '').trim();
    if (!digits || digits.length > 32 || !/^[0-9*#wW]+$/.test(digits)) {
      throw new Error('DTMF digits can contain only 0-9, *, #, w, or W');
    }

    const call = getStore().calls.find((item) => item.id === callId);
    if (!call) throw new Error('Call not found');
    if (call.status !== 'in_progress' || call.completedAt) {
      throw new Error('DTMF can only be sent during a connected call');
    }
    if (typeof this.voiceProvider.sendDigits !== 'function') {
      throw new Error(`${this.voiceProvider.name} does not support dial-pad digits`);
    }

    const result = await this.voiceProvider.sendDigits(call, digits);
    addEvent('call_dtmf_sent', `Sent dial-pad digit${digits.length === 1 ? '' : 's'}`, {
      campaignId: call.campaignId,
      callId: call.id
    });
    return { ok: true, digits, providerResult: result };
  }

  async updateHubSpotLeadSafe(call, lead, patch, eventType = 'hubspot_write_failed') {
    if (config.leadSource !== 'hubspot') return { skipped: true };
    try {
      const result = await updateHubSpotLead(lead, patch);
      if (result?.partial) {
        addEvent('hubspot_partial_update', `HubSpot partially updated ${lead.name}`, {
          campaignId: call.campaignId,
          callId: call.id,
          leadId: lead.id,
          failures: result.failures || []
        });
      }
      return result;
    } catch (error) {
      addEvent(eventType, error.message, {
        campaignId: call.campaignId,
        callId: call.id,
        leadId: lead.id,
        patch
      });
      return { error: error.message };
    }
  }

  async createHubSpotCallLogSafe(call, lead, outcome, eventType = 'hubspot_call_log_failed') {
    if (config.leadSource !== 'hubspot' || call.hubspotCallLoggedAt) return { skipped: true };
    try {
      const result = await createHubSpotCallLog(call, lead, outcome);
      updateCall(call.id, {
        hubspotCallLoggedAt: new Date().toISOString(),
        hubspotCallLogId: result?.id || call.hubspotCallLogId || ''
      });
      return result;
    } catch (error) {
      addEvent(eventType, error.message, {
        campaignId: call.campaignId,
        callId: call.id,
        leadId: lead.id,
        outcome
      });
      return { error: error.message };
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

      await this.updateHubSpotLeadSafe(updatedCall, updatedLead, {
        status: leadStatus,
        lastOutcome: outcome,
        attempts: updatedLead.attempts
      });
      if (!requiresDisposition) {
        await this.createHubSpotCallLogSafe(updatedCall, updatedLead, outcome);
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
    } else {
      this.resumeCampaignQueue(updatedCall.campaignId, `call_completed_${outcome}`);
    }

    return updatedCall;
  }

  async markCustomerAnswered(campaignId, leadId, raw = {}) {
    const data = getStore();
    const call = data.calls.find((item) => item.campaignId === campaignId && item.leadId === leadId && !item.completedAt);
    if (!call) return { call: null, abandoned: true };

    const existingLiveCall = data.calls.find((item) => (
      item.campaignId === campaignId
      && item.sessionId === call.sessionId
      && item.id !== call.id
      && !item.completedAt
      && LIVE_CALL_STATUSES.has(item.status)
    ));

    if (existingLiveCall) {
      const abandonedCall = await this.abandonCall(call, 'another_customer_connected', raw);
      return { call: abandonedCall, abandoned: true };
    }

    const updatedCall = updateCall(call.id, {
      status: 'in_progress',
      answeredAt: new Date().toISOString(),
      providerLiveCallId: raw.CallUUID || call.providerLiveCallId || '',
      raw
    });

    await this.cancelCompetingCalls(updatedCall);

    addEvent('customer_joined_agent_session', `${call.leadName} answered and joined the agent session`, {
      campaignId,
      callId: call.id,
      leadId
    });

    return { call: updatedCall, abandoned: false };
  }

  async abandonCall(call, reason = 'agent_busy', raw = {}) {
    const completedAt = new Date().toISOString();
    const updatedCall = updateCall(call.id, {
      status: 'completed',
      completedAt,
      answeredAt: call.answeredAt || completedAt,
      outcome: 'abandoned',
      abandonReason: reason,
      requiresDisposition: false,
      providerLiveCallId: raw.CallUUID || call.providerLiveCallId || '',
      raw
    });

    updateLead(call.leadId, {
      status: 'retry',
      lastOutcome: 'abandoned'
    });

    addEvent('call_abandoned', `${call.leadName} answered after another call was already connected`, {
      campaignId: call.campaignId,
      callId: call.id,
      leadId: call.leadId,
      reason
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
      agentCallId: raw.RequestUUID || session.agentCallId || '',
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
    if (!providerCallId && raw.role !== 'agent') return null;
    const data = getStore();
    const session = data.sessions.find((item) => (
      (providerCallId && (item.agentCallId === providerCallId || item.agentLiveCallId === providerCallId))
      || (raw.role === 'agent' && raw.sessionId && item.id === raw.sessionId)
    ));
    if (!session) return null;

    updateSession(session.id, {
      agentCallStatus: providerStatus || 'completed',
      agentEndedAt: new Date().toISOString(),
      rawAgentHangup: raw
    });

    const campaign = getStore().campaigns.find((item) => item.id === session.campaignId);
    if (campaign && ['running', 'connected'].includes(campaign.status)) {
      await this.stopCampaign(campaign.id, 'paused', { skipProviderCallId: providerCallId });
    }

    addEvent('agent_session_ended', `Agent session ended for ${campaign?.name || session.campaignId}`, {
      campaignId: session.campaignId,
      sessionId: session.id,
      providerCallId,
      providerStatus
    });

    return session;
  }

  async hangupCustomerCall(callId) {
    const data = getStore();
    const call = data.calls.find((item) => item.id === callId);
    if (!call) throw new Error('Call not found');
    if (!ACTIVE_STATUSES.has(call.status)) {
      return { call, alreadyEnded: true };
    }

    try {
      if (typeof this.voiceProvider.cancelOutboundCall === 'function') {
        await this.voiceProvider.cancelOutboundCall(call);
      }
    } catch (error) {
      addEvent('agent_hangup_provider_failed', error.message, {
        campaignId: call.campaignId,
        callId: call.id
      });
    }

    const latest = getStore().calls.find((item) => item.id === call.id);
    if (latest?.completedAt) return { call: latest, alreadyEnded: true };

    const completed = await this.completeCall(latest, 'live_answer', {
      source: 'agent_hangup',
      HangupSource: 'agent'
    });
    addEvent('agent_hung_up_customer', `Agent ended call with ${call.leadName}`, {
      campaignId: call.campaignId,
      callId: call.id,
      leadId: call.leadId
    });
    return { call: completed };
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
    const completedAt = call.completedAt || new Date().toISOString();
    const callOutcome = call.outcome || 'live_answer';

    const updatedCall = updateCall(call.id, {
      status: 'completed',
      completedAt,
      outcome: callOutcome,
      requiresDisposition: false,
      dispositionStatus: status,
      dispositionNote: String(input.note || '').trim(),
      dispositionAt: new Date().toISOString()
    });

    const updatedLead = updateLead(lead.id, {
      status,
      lastOutcome: status
    });

    const hubspotUpdate = await this.updateHubSpotLeadSafe(updatedCall, updatedLead, {
      status,
      lastOutcome: status,
      attempts: updatedLead.attempts
    }, 'hubspot_disposition_failed');
    const hubspotCallLog = await this.createHubSpotCallLogSafe(
      { ...updatedCall, dispositionStatus: status, dispositionNote: String(input.note || '').trim() },
      updatedLead,
      status
    );

    addEvent('call_disposition_saved', `${call.leadName} set to ${status}`, {
      campaignId: call.campaignId,
      callId: call.id,
      leadId: lead.id
    });

    this.resumeCampaignQueue(call.campaignId, 'disposition_saved');

    return { call: updatedCall, lead: updatedLead, hubspotUpdate, hubspotCallLog };
  }

  async completeProviderCall(providerCallId, providerStatus, answeredBy, raw = {}) {
    const data = getStore();
    const call = data.calls.find((item) => (
      (providerCallId && (item.providerCallId === providerCallId || item.providerLiveCallId === providerCallId))
      || (raw.campaignId && raw.leadId && item.campaignId === raw.campaignId && item.leadId === raw.leadId && !item.completedAt)
    ));
    if (!call) {
      const session = await this.completeAgentSession(providerCallId, providerStatus, raw);
      if (session) return session;

      addEvent('unknown_provider_call', `No local call matched provider id ${providerCallId}`, raw);
      return null;
    }

    if (call.completedAt || call.outcome === 'abandoned') {
      const correctedOutcome = providerStatusToOutcome(providerStatus, answeredBy, raw);
      if (
        correctedOutcome === 'voicemail'
        && call.outcome === 'live_answer'
        && call.requiresDisposition
        && !call.dispositionAt
      ) {
        return this.completeCall(call, 'voicemail', {
          ...raw,
          correctedFrom: 'live_answer'
        });
      }
      updateCall(call.id, {
        lastProviderStatus: providerStatus || call.lastProviderStatus || '',
        rawHangup: raw
      });
      return call;
    }

    let outcome = providerStatusToOutcome(providerStatus, answeredBy, raw);
    if (call.status === 'in_progress' && isTerminalProviderStatus(providerStatus, raw) && outcome !== 'voicemail') {
      outcome = 'live_answer';
    }
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
      .filter((lead) => matchesCampaignLeadStatus(lead, campaign))
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
