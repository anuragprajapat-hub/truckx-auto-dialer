import { config } from './config.js';
import { evaluateLeadForDial, isCallableStatus } from './compliance.js';
import { addCall, addEvent, getStore, setCampaignStatus, updateCall, updateLead, upsertLeads, upsertOwners } from './store.js';
import { createHubSpotCallLog, fetchContactsForOwner, fetchHubSpotOwners, updateHubSpotLead } from './hubspot.js';
import { createVoiceProvider } from './voice/index.js';
import { selectCallerIdNumber } from './voice/callerId.js';

const ACTIVE_STATUSES = new Set(['dialing', 'queued', 'ringing', 'in_progress']);
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
  if (normalizedStatus === 'no-answer' || normalizedStatus === 'no_answer') return 'no_answer';
  if (normalizedStatus === 'failed' || normalizedStatus === 'canceled') return 'failed';
  if (normalizedStatus === 'completed') return 'live_answer';
  return '';
}

export class DialerEngine {
  constructor() {
    this.voiceProvider = createVoiceProvider();
    this.timer = null;
    this.isTicking = false;
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
    addEvent('hubspot_sync', `Synced ${count} HubSpot contacts`, { campaignId });
    return { count };
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

    for (const campaign of runningCampaigns) {
      const fresh = getStore();
      const activeCalls = fresh.calls.filter((call) => call.campaignId === campaign.id && ACTIVE_STATUSES.has(call.status));
      const openSlots = Math.max(0, Number(campaign.maxParallelCalls || 1) - activeCalls.length);
      if (!openSlots) continue;

      const dncNumbers = new Set((fresh.dncNumbers || []).map((item) => item.phone));
      const activeLeadIds = new Set(activeCalls.map((call) => call.leadId));
      const leads = fresh.leads
        .filter((lead) => lead.ownerId === campaign.ownerId)
        .filter((lead) => isCallableStatus(lead.status))
        .filter((lead) => !activeLeadIds.has(lead.id))
        .filter((lead) => evaluateLeadForDial(lead, campaign, { dncNumbers }).allowed)
        .slice(0, openSlots);

      if (!leads.length && activeCalls.length === 0) {
        const anyReady = fresh.leads.some((lead) => lead.ownerId === campaign.ownerId && isCallableStatus(lead.status));
        if (!anyReady) {
          setCampaignStatus(campaign.id, 'complete');
          addEvent('campaign_complete', `Campaign ${campaign.name} completed`, { campaignId: campaign.id });
        }
        continue;
      }

      for (const lead of leads) {
        await this.startCall(campaign, lead);
      }
    }
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
    const patchedLead = updateLead(lead.id, {
      phone: allowed.phone,
      attempts: attempt,
      status: 'dialing'
    });

    try {
      const callerIdNumber = selectCallerIdNumber(patchedLead, campaign, attempt);
      const providerCall = await this.voiceProvider.createOutboundCall({
        lead: patchedLead,
        campaign,
        callerIdNumber
      });

      const call = addCall({
        campaignId: campaign.id,
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
        status: 'retry',
        lastOutcome: 'provider_error'
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

    const updatedCall = updateCall(call.id, {
      status: 'completed',
      completedAt,
      outcome,
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

    return updatedCall;
  }

  async completeProviderCall(providerCallId, providerStatus, answeredBy, raw = {}) {
    const data = getStore();
    const call = data.calls.find((item) => item.providerCallId === providerCallId);
    if (!call) {
      addEvent('unknown_provider_call', `No local call matched provider id ${providerCallId}`, raw);
      return null;
    }

    const outcome = providerStatusToOutcome(providerStatus, answeredBy);
    if (!outcome) {
      updateCall(call.id, {
        status: providerStatus || call.status,
        raw
      });
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
