let state = null;
let setup = null;
let selectedCampaignId = '';
let activeView = 'powerlists';
let campaignSettingsDraft = {
  campaignId: '',
  dirty: false
};
let selectedCampaignSnapshot = null;
let stateLoadInFlight = false;
let snapshotRequestId = 0;
const DASHBOARD_TIME_ZONE = 'America/Los_Angeles';
const ACTIVE_CALL_STATUSES = new Set(['dialing', 'queued', 'ringing', 'in_progress']);

const elements = {
  systemLine: document.querySelector('#systemLine'),
  viewTitle: document.querySelector('#viewTitle'),
  navButtons: document.querySelectorAll('[data-view]'),
  statCampaigns: document.querySelector('#statCampaigns'),
  statDials: document.querySelector('#statDials'),
  statActive: document.querySelector('#statActive'),
  statConnected: document.querySelector('#statConnected'),
  statVm: document.querySelector('#statVm'),
  statHours: document.querySelector('#statHours'),
  ownerSelect: document.querySelector('#ownerSelect'),
  syncOwnersButton: document.querySelector('#syncOwnersButton'),
  campaignForm: document.querySelector('#campaignForm'),
  campaignCallerId: document.querySelector('#campaignCallerId'),
  verifiedCallerIdOptions: document.querySelector('#verifiedCallerIdOptions'),
  campaignList: document.querySelector('#campaignList'),
  activeCampaignName: document.querySelector('#activeCampaignName'),
  activeCampaignMeta: document.querySelector('#activeCampaignMeta'),
  notice: document.querySelector('#notice'),
  activeCalls: document.querySelector('#activeCalls'),
  callLog: document.querySelector('#callLog'),
  abandonedCalls: document.querySelector('#abandonedCalls'),
  eventLog: document.querySelector('#eventLog'),
  setupStatus: document.querySelector('#setupStatus'),
  agentReports: document.querySelector('#agentReports'),
  reportRows: document.querySelector('#reportRows'),
  historyRows: document.querySelector('#historyRows'),
  historySearch: document.querySelector('#historySearch'),
  agentInviteForm: document.querySelector('#agentInviteForm'),
  agentOwnerSelect: document.querySelector('#agentOwnerSelect'),
  endpointProvisioningStatus: document.querySelector('#endpointProvisioningStatus'),
  agentRows: document.querySelector('#agentRows'),
  dispositionPanel: document.querySelector('#dispositionPanel'),
  dispositionLead: document.querySelector('#dispositionLead'),
  dispositionForm: document.querySelector('#dispositionForm'),
  dispositionStatus: document.querySelector('#dispositionStatus'),
  dispositionNote: document.querySelector('#dispositionNote'),
  dncForm: document.querySelector('#dncForm'),
  dncPhone: document.querySelector('#dncPhone'),
  dncReason: document.querySelector('#dncReason'),
  dncList: document.querySelector('#dncList'),
  refreshCallerIdsButton: document.querySelector('#refreshCallerIdsButton'),
  refreshButton: document.querySelector('#refreshButton'),
  startButton: document.querySelector('#startButton'),
  stopButton: document.querySelector('#stopButton'),
  deleteCampaignButton: document.querySelector('#deleteCampaignButton'),
  updateCampaignButton: document.querySelector('#updateCampaignButton'),
  selectedCampaignLines: document.querySelector('#selectedCampaignLines'),
  selectedCampaignCallerId: document.querySelector('#selectedCampaignCallerId'),
  resetProviderErrorsButton: document.querySelector('#resetProviderErrorsButton'),
  syncHubSpotButton: document.querySelector('#syncHubSpotButton')
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fallbackLeadStatusOptions() {
  return [
    { label: 'New', value: 'NEW' },
    { label: 'Connected', value: 'CONNECTED' },
    { label: 'Follow up', value: 'FOLLOWUP' },
    { label: 'Qualified', value: 'QUALIFIED' },
    { label: 'Not interested', value: 'NOT_INTERESTED' },
    { label: 'Bad timing', value: 'BAD_TIMING' },
    { label: 'Do not call', value: 'DO_NOT_CALL' }
  ];
}

function leadStatusOptions() {
  return state?.settings?.leadStatusOptions?.options?.length
    ? state.settings.leadStatusOptions.options
    : fallbackLeadStatusOptions();
}

function leadStatusLabel(value) {
  const clean = String(value || '');
  const option = leadStatusOptions().find((item) => String(item.value) === clean);
  return option?.label || clean.replaceAll('_', ' ');
}

function verifiedCallerIds() {
  return state?.settings?.verifiedCallerIds?.callerIds || [];
}

function renderVerifiedCallerIds() {
  if (!elements.verifiedCallerIdOptions) return;
  elements.verifiedCallerIdOptions.innerHTML = verifiedCallerIds()
    .map((callerId) => (
      `<option value="${escapeHtml(callerId.phoneNumber)}">${escapeHtml(callerId.alias || callerId.phoneNumber)}</option>`
    ))
    .join('');
}

function statusClass(value) {
  return String(value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_');
}

function renderDispositionOptions() {
  if (!elements.dispositionStatus) return;
  const options = leadStatusOptions();
  const key = options.map((option) => `${option.value}:${option.label}`).join('|');
  if (elements.dispositionStatus.dataset.optionsKey === key) return;

  const currentValue = elements.dispositionStatus.value;
  elements.dispositionStatus.innerHTML = [
    '<option value="">Select lead status</option>',
    ...options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
  ].join('');
  elements.dispositionStatus.dataset.optionsKey = key;
  if (options.some((option) => String(option.value) === currentValue)) {
    elements.dispositionStatus.value = currentValue;
  }
}

function hubspotUpdateWarning(result) {
  const update = result?.hubspotUpdate;
  if (!update) return '';
  if (update.queued) return '';
  if (update.error) return update.error;
  if (update.partial) return (update.failures || []).join('; ') || 'Some HubSpot fields were not updated.';
  return '';
}

function hubspotSyncQueued(result) {
  return Boolean(result?.hubspotUpdate?.queued || result?.hubspotCallLog?.queued);
}

function hubspotSyncMessage(result) {
  const count = result?.count || 0;
  const resetCount = result?.providerErrorsReset || 0;
  const omittedProperties = result?.omittedProperties || [];
  return [
    count
      ? `Synced ${count} HubSpot contact(s) for this owner.`
      : 'Synced HubSpot, but found 0 contacts for this owner. Check that contacts have this HubSpot owner.',
    resetCount ? `Cleared ${resetCount} old provider error lead(s).` : '',
    omittedProperties.length
      ? `Skipped unavailable optional properties: ${omittedProperties.join(', ')}.`
      : ''
  ].filter(Boolean).join(' ');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Request failed with ${response.status}`);
  }
  return body;
}

function statusPill(value, extraClass = '') {
  const clean = String(value || 'unknown');
  return `<span class="pill ${escapeHtml(statusClass(clean))} ${extraClass}">${escapeHtml(leadStatusLabel(clean))}</span>`;
}

function campaignTarget(campaign) {
  const target = String(campaign?.timeZoneTarget || 'ALL').toUpperCase();
  return ['EST', 'CST', 'MST', 'PST'].includes(target) ? target : 'ALL';
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function reportingDateKey(value, timeZone = state?.dashboard?.timeZone || DASHBOARD_TIME_ZONE) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isDashboardDay(value) {
  const today = state?.dashboard?.dateKey || reportingDateKey(new Date());
  return reportingDateKey(value) === today;
}

function isActiveCall(call) {
  return ACTIVE_CALL_STATUSES.has(call.status);
}

function dashboardCalls() {
  return (state?.calls || []).filter((call) => (
    isActiveCall(call)
    || isDashboardDay(call.startedAt)
    || isDashboardDay(call.completedAt)
    || isDashboardDay(call.createdAt)
  ));
}

function dashboardEvents() {
  return (state?.events || []).filter((event) => isDashboardDay(event.createdAt));
}

function callDuration(call) {
  if (!call.startedAt || !call.completedAt) return '';
  const seconds = Math.max(0, Math.round((new Date(call.completedAt).getTime() - new Date(call.startedAt).getTime()) / 1000));
  return formatDuration(seconds);
}

function latestInviteForAgent(agent) {
  return (state.agentInvites || []).find((invite) => invite.agentId === agent.id || invite.email === agent.email);
}

function inviteEmailStatus(invite) {
  if (!invite) return '';
  if (invite.emailSent) return 'email sent';
  if (invite.emailError) return invite.emailError;
  return 'manual link';
}

function agentAccessStatus(agent) {
  return agent.extensionStatus === 'not_installed'
    ? 'not_connected'
    : (agent.extensionStatus || 'not_connected');
}

async function copyText(value) {
  if (!value) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement('input');
  input.value = value;
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

function pendingDispositionCall() {
  const campaign = selectedCampaign();
  if (!campaign) return null;
  return state.calls.find((call) => call.campaignId === campaign.id && call.requiresDisposition);
}

function setView(view) {
  activeView = view || 'powerlists';
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `view-${activeView}`);
  });
  elements.navButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.view === activeView);
  });
  const titles = {
    powerlists: 'PowerLists',
    reports: 'Agent Reports',
    history: 'Call History',
    agents: 'Agents',
    live: 'Live',
    setup: 'Setup'
  };
  elements.viewTitle.textContent = titles[activeView] || 'PowerLists';
}

function setNotice(message, type = 'info') {
  if (!message) {
    elements.notice.hidden = true;
    elements.notice.textContent = '';
    elements.notice.className = 'notice';
    return;
  }

  elements.notice.hidden = false;
  elements.notice.textContent = message;
  elements.notice.className = `notice ${type}`;
}

function selectedCampaign() {
  const campaigns = activeCampaigns();
  if (!campaigns.length) return null;
  return campaigns.find((campaign) => campaign.id === selectedCampaignId) || campaigns[0];
}

function activeCampaigns() {
  return (state?.campaigns || []).filter((campaign) => campaign.status !== 'deleted' && !campaign.deletedAt);
}

function visibleOwners() {
  const owners = state.owners || [];
  const realOwners = owners.filter((owner) => !String(owner.id || '').startsWith('owner_demo_'));
  return realOwners.length ? realOwners : owners;
}

function renderOwners() {
  const currentPowerListOwner = elements.ownerSelect.value;
  const currentAgentOwner = elements.agentOwnerSelect.value;
  const owners = visibleOwners();
  const ownerOptions = owners
    .map((owner) => `<option value="${escapeHtml(owner.id)}">${escapeHtml(owner.name)}</option>`)
    .join('');
  elements.ownerSelect.innerHTML = ownerOptions;
  elements.agentOwnerSelect.innerHTML = ownerOptions;
  if (owners.some((owner) => owner.id === currentPowerListOwner)) {
    elements.ownerSelect.value = currentPowerListOwner;
  }
  if (owners.some((owner) => owner.id === currentAgentOwner)) {
    elements.agentOwnerSelect.value = currentAgentOwner;
  }

  const owner = owners.find((item) => item.id === elements.ownerSelect.value);
  if (owner && !document.querySelector('#agentPhone').value) {
    document.querySelector('#agentPhone').value = owner.agentPhone || '';
  }
  if (owner && !elements.campaignCallerId.value) {
    const agent = state.agents.find((item) => (
      item.ownerId === owner.id
      || String(item.hubspotOwnerId || '') === String(owner.hubspotOwnerId || '')
    ));
    elements.campaignCallerId.value = agent?.callerIdNumber || '';
  }
}

function renderStats() {
  const summary = state.dashboard || {};
  const todayCalls = dashboardCalls();
  const activeCalls = Number.isFinite(Number(summary.activeCalls))
    ? Number(summary.activeCalls)
    : (state.calls || []).filter(isActiveCall).length;
  const connected = Number.isFinite(Number(summary.connected))
    ? Number(summary.connected)
    : todayCalls.filter((call) => call.outcome === 'live_answer').length;
  const vm = Number.isFinite(Number(summary.voicemail))
    ? Number(summary.voicemail)
    : todayCalls.filter((call) => call.outcome === 'voicemail').length;
  const dials = Number.isFinite(Number(summary.totalCalls)) ? Number(summary.totalCalls) : todayCalls.length;
  const dialerSeconds = Number.isFinite(Number(summary.dialerSeconds)) ? Number(summary.dialerSeconds) : 0;

  const providerAccount = state.settings.providerAccount ? ` (${state.settings.providerAccount})` : '';
  elements.systemLine.textContent = `Provider: ${state.settings.voiceProvider}${providerAccount} | Lead source: ${state.settings.leadSource} | Caller IDs: ${state.settings.callerIdNumbers.length} | Dashboard: Today PST`;
  elements.statCampaigns.textContent = activeCampaigns().length;
  elements.statDials.textContent = dials;
  elements.statActive.textContent = activeCalls;
  elements.statConnected.textContent = connected;
  elements.statVm.textContent = vm;
  elements.statHours.textContent = formatDuration(dialerSeconds);
}

function renderCampaigns() {
  const campaigns = activeCampaigns();
  if (!campaigns.length) {
    elements.campaignList.innerHTML = '<div class="empty">No campaigns yet</div>';
    return;
  }

  const selected = selectedCampaign();
  selectedCampaignId = selected.id;

  elements.campaignList.innerHTML = campaigns
    .map((campaign) => {
      const owner = state.owners.find((item) => item.id === campaign.ownerId);
      const active = campaign.id === selectedCampaignId ? 'active' : '';
      const statusFilter = campaign.leadStatusFilters?.length
        ? ` | ${campaign.leadStatusFilters.map(leadStatusLabel).join(', ')}`
        : '';
      return `
        <button class="campaign-item ${active}" data-campaign-id="${escapeHtml(campaign.id)}">
          <strong>${escapeHtml(campaign.name)}</strong>
          <span>${escapeHtml(owner?.name || 'Unknown owner')} | ${campaignTarget(campaign)} | ${campaign.maxParallelCalls} lines | ${campaign.status}${escapeHtml(statusFilter)}</span>
        </button>
      `;
    })
    .join('');

  document.querySelectorAll('.campaign-item').forEach((button) => {
    button.addEventListener('click', async () => {
      if (button.dataset.campaignId === selectedCampaignId) return;
      selectedCampaignId = button.dataset.campaignId;
      selectedCampaignSnapshot = {
        campaignId: selectedCampaignId,
        loading: true
      };
      renderCampaigns();
      renderSelectedCampaign();
      await loadSelectedCampaignSnapshot();
    });
  });
}

function renderSelectedCampaign() {
  const campaign = selectedCampaign();
  if (!campaign) {
    campaignSettingsDraft = { campaignId: '', dirty: false };
    elements.activeCampaignName.textContent = 'Queue';
    elements.activeCampaignMeta.textContent = 'No campaign selected';
    elements.startButton.disabled = true;
    elements.stopButton.disabled = true;
    elements.deleteCampaignButton.disabled = true;
    elements.updateCampaignButton.disabled = true;
    elements.selectedCampaignLines.disabled = true;
    elements.selectedCampaignCallerId.disabled = true;
    elements.syncHubSpotButton.disabled = true;
    elements.resetProviderErrorsButton.disabled = true;
    return;
  }

  const owner = state.owners.find((item) => item.id === campaign.ownerId);
  const snapshotMatches = selectedCampaignSnapshot?.campaignId === campaign.id;
  const snapshotError = snapshotMatches ? selectedCampaignSnapshot.error : '';
  const snapshotReady = snapshotMatches
    && !selectedCampaignSnapshot.loading
    && !snapshotError;
  const summary = snapshotReady ? selectedCampaignSnapshot.summary : null;
  elements.activeCampaignName.textContent = campaign.name;
  elements.activeCampaignMeta.textContent = `${owner?.name || 'Owner'} | ${campaign.status} | ${campaignTarget(campaign)} | ${campaign.maxParallelCalls} lines`;
  elements.startButton.disabled = !snapshotReady
    || ['running', 'connected'].includes(campaign.status)
    || summary.ready === 0;
  elements.stopButton.disabled = !['running', 'connected', 'paused'].includes(campaign.status);
  elements.deleteCampaignButton.disabled = false;
  elements.updateCampaignButton.disabled = false;
  elements.selectedCampaignLines.disabled = false;
  elements.selectedCampaignCallerId.disabled = false;
  if (campaignSettingsDraft.campaignId !== campaign.id || !campaignSettingsDraft.dirty) {
    elements.selectedCampaignLines.value = campaign.maxParallelCalls || 1;
    elements.selectedCampaignCallerId.value = campaign.callerIdNumber || campaign.callerIdNumbers?.[0] || '';
    campaignSettingsDraft = {
      campaignId: campaign.id,
      dirty: false
    };
  }
  elements.syncHubSpotButton.disabled = state.settings.leadSource !== 'hubspot';
  elements.resetProviderErrorsButton.disabled = !summary?.hasProviderErrors;
}

function renderCalls() {
  const campaign = selectedCampaign();
  const calls = dashboardCalls();
  const activeCalls = (state.calls || []).filter((call) => (!campaign || call.campaignId === campaign.id) && isActiveCall(call));
  const logs = calls.filter((call) => !campaign || call.campaignId === campaign.id).slice(0, 12);
  const abandonedCalls = calls.filter((call) => (!campaign || call.campaignId === campaign.id) && call.outcome === 'abandoned').slice(0, 12);

  elements.activeCalls.innerHTML = activeCalls.length
    ? activeCalls
        .map((call) => `
          <div class="call-card">
            <strong>${escapeHtml(call.leadName)}</strong>
            <span>${escapeHtml(call.leadPhone)} | ${escapeHtml(call.provider)} | attempt ${escapeHtml(call.attempt)}</span>
            ${statusPill(call.status)}
          </div>
        `)
        .join('')
    : '<div class="empty">No active calls</div>';

  elements.callLog.innerHTML = logs.length
    ? logs
        .map((call) => `
          <div class="log-item">
            <strong>${escapeHtml(call.leadName)}</strong>
            <span>${escapeHtml(new Date(call.startedAt).toLocaleTimeString())} | ${escapeHtml(call.leadPhone)}</span>
            ${statusPill(call.outcome || call.status)}
          </div>
        `)
        .join('')
    : '<div class="empty">No calls yet</div>';

  elements.abandonedCalls.innerHTML = abandonedCalls.length
    ? abandonedCalls
        .map((call) => `
          <div class="log-item">
            <strong>${escapeHtml(call.leadName)}</strong>
            <span>${escapeHtml(new Date(call.completedAt || call.startedAt).toLocaleTimeString())} | ${escapeHtml(call.leadPhone)}</span>
            ${statusPill('abandoned')}
          </div>
        `)
        .join('')
    : '<div class="empty">No abandoned calls</div>';
}

function renderEvents() {
  const events = dashboardEvents();
  elements.eventLog.innerHTML = events.length
    ? events
        .slice(0, 12)
        .map((event) => `
          <div class="event-item">
            <strong>${escapeHtml(event.message)}</strong>
            <span>${escapeHtml(event.type)} | ${escapeHtml(new Date(event.createdAt).toLocaleTimeString())}</span>
          </div>
        `)
        .join('')
    : '<div class="empty">No events yet</div>';
}

function renderSetup() {
  if (!setup?.checks?.length) {
    elements.setupStatus.innerHTML = '<div class="empty">Setup status unavailable</div>';
    return;
  }

  elements.syncOwnersButton.disabled = state.settings.leadSource !== 'hubspot';
  elements.setupStatus.innerHTML = setup.checks
    .map((check) => `
      <div class="setup-item">
        <div>
          <strong>${escapeHtml(check.label)}</strong>
          <span>${escapeHtml(check.message)}</span>
        </div>
        ${statusPill(check.ok ? 'ready' : 'missing', check.ok ? 'allowed' : 'blocked')}
      </div>
    `)
    .join('');
}

function renderDnc() {
  const dncNumbers = state.dncNumbers || [];
  elements.dncList.innerHTML = dncNumbers.length
    ? dncNumbers
        .slice(0, 8)
        .map((record) => `
          <div class="dnc-item">
            <div>
              <strong>${escapeHtml(record.phone)}</strong>
              <span>${escapeHtml(record.reason || record.source || 'DNC')}</span>
            </div>
            <button data-dnc-remove="${escapeHtml(record.phone)}" type="button" title="Remove from DNC">Remove</button>
          </div>
        `)
        .join('')
    : '<div class="empty">No global DNC numbers</div>';

  document.querySelectorAll('[data-dnc-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api('/api/dnc/remove', {
        method: 'POST',
        body: JSON.stringify({ phone: button.dataset.dncRemove })
      });
      await loadState();
    });
  });
}

function renderDisposition() {
  const call = pendingDispositionCall();
  if (!call) {
    elements.dispositionPanel.hidden = true;
    elements.dispositionForm.dataset.callId = '';
    return;
  }

  elements.dispositionPanel.hidden = false;
  elements.dispositionLead.textContent = `${call.leadName} | ${call.leadPhone} | ${call.outcome || 'completed'}`;
  elements.dispositionForm.dataset.callId = call.id;
}

function renderReports() {
  const reports = state.reports?.agents || [];
  elements.agentReports.innerHTML = reports.length
    ? reports
        .map((report) => `
          <div class="report-item">
            <strong>${escapeHtml(report.name)}</strong>
            <span>${escapeHtml(report.email || report.hubspotOwnerId || '')}</span>
            <div class="report-metrics">
              <span>${escapeHtml(report.totalCalls)} calls</span>
              <span>${escapeHtml(report.connected)} live</span>
              <span>${escapeHtml(report.voicemail)} VM</span>
              <span>${escapeHtml(report.abandoned || 0)} abandoned</span>
              <span>${escapeHtml(formatDuration(report.dialerSeconds))}</span>
              <span>${escapeHtml(report.activeCalls)} active</span>
              <span>${escapeHtml(report.noAnswer)} no answer</span>
            </div>
          </div>
        `)
        .join('')
    : '<div class="empty">No agent activity yet</div>';

  elements.reportRows.innerHTML = reports.length
    ? reports
        .map((report) => `
          <tr>
            <td>
              <div class="lead-name">
                <strong>${escapeHtml(report.name)}</strong>
                <span>${escapeHtml(report.email || '')}</span>
              </div>
            </td>
            <td>${escapeHtml(report.totalCalls)}</td>
            <td>${escapeHtml(report.connected)}</td>
            <td>${escapeHtml(report.voicemail)}</td>
            <td>${escapeHtml(report.noAnswer)}</td>
            <td>${escapeHtml(report.abandoned || 0)}</td>
            <td>${escapeHtml(formatDuration(report.dialerSeconds))}</td>
          </tr>
        `)
        .join('')
    : '<tr><td colspan="7">No agent activity yet.</td></tr>';
}

function renderHistory() {
  const search = String(elements.historySearch.value || '').toLowerCase();
  const rows = state.calls
    .filter((call) => {
      const campaign = state.campaigns.find((item) => item.id === call.campaignId);
      const owner = state.owners.find((item) => item.id === call.ownerId);
      const haystack = [
        call.leadName,
        call.leadPhone,
        call.status,
        call.outcome,
        campaign?.name,
        owner?.name
      ].join(' ').toLowerCase();
      return !search || haystack.includes(search);
    })
    .slice(0, 100);

  elements.historyRows.innerHTML = rows.length
    ? rows
        .map((call) => {
          const campaign = state.campaigns.find((item) => item.id === call.campaignId);
          const owner = state.owners.find((item) => item.id === call.ownerId);
          return `
            <tr>
              <td>${escapeHtml(new Date(call.startedAt).toLocaleString())}</td>
              <td>${escapeHtml(owner?.name || call.ownerId || '')}</td>
              <td>${escapeHtml(call.leadName || '')}</td>
              <td>${escapeHtml(call.leadPhone || '')}</td>
              <td>${escapeHtml(campaign?.name || '')}</td>
              <td>${statusPill(call.status)}</td>
              <td>${statusPill(call.outcome || 'not_disposed')}</td>
              <td>${escapeHtml(callDuration(call))}</td>
            </tr>
          `;
        })
        .join('')
    : '<tr><td colspan="8">No records to display</td></tr>';
}

function renderAgents() {
  const agents = state.agents || [];
  const endpointReadiness = state.settings?.endpointReadiness || {};
  if (elements.endpointProvisioningStatus) {
    elements.endpointProvisioningStatus.textContent = endpointReadiness.ready
      ? `Automatic endpoint creation is ready. Plivo currently has ${endpointReadiness.endpointCount || 0} endpoint(s).`
      : `Automatic endpoint creation is not ready: ${endpointReadiness.error || 'set PLIVO_APPLICATION_ID or attach the shared endpoint to the TruckX Plivo application.'}`;
    elements.endpointProvisioningStatus.className = endpointReadiness.ready ? 'notice success' : 'notice error';
  }
  elements.agentRows.innerHTML = agents.length
    ? agents
        .map((agent) => {
          const invite = latestInviteForAgent(agent);
          const inviteCell = invite?.inviteUrl
            ? `
              <div class="invite-actions">
                <button type="button" data-copy-invite="${escapeHtml(invite.inviteUrl)}">Copy web login link</button>
                <span>${escapeHtml(inviteEmailStatus(invite))}</span>
              </div>
            `
            : '<span class="muted">No invite</span>';
          const accessStatus = agentAccessStatus(agent);
          const canDisconnect = accessStatus !== 'disconnected'
            && (accessStatus === 'connected' || agent.status === 'active' || Boolean(agent.lastSeenAt));
          const actionCell = canDisconnect
            ? `<button class="danger-outline-button" type="button" data-disconnect-agent="${escapeHtml(agent.id)}">Disconnect</button>`
            : '<span class="muted">No active session</span>';
          return `
            <tr>
              <td>${escapeHtml(agent.name)}</td>
              <td>${escapeHtml(agent.email)}</td>
              <td>${escapeHtml(agent.hubspotOwnerId || agent.ownerId || '')}</td>
              <td>${escapeHtml(agent.callerIdNumber || 'Not assigned')}</td>
              <td>${agent.plivoEndpointManaged ? 'Automatic' : agent.plivoEndpointConfigured ? 'Manual' : 'Global fallback'}</td>
              <td>${statusPill(agent.status || 'invited')}</td>
              <td>${statusPill(accessStatus)}</td>
              <td>${inviteCell}</td>
              <td>
                <div class="agent-actions">
                  ${actionCell}
                  <button class="danger-outline-button" type="button" data-delete-agent="${escapeHtml(agent.id)}">Delete</button>
                </div>
              </td>
            </tr>
          `;
        })
        .join('')
    : '<tr><td colspan="9">No invited agents yet.</td></tr>';

  document.querySelectorAll('[data-copy-invite]').forEach((button) => {
    button.addEventListener('click', async () => {
      await copyText(button.dataset.copyInvite);
      setNotice('Web login link copied. Send it to the agent and ask them to open it in Chrome.', 'success');
    });
  });

  document.querySelectorAll('[data-disconnect-agent]').forEach((button) => {
    button.addEventListener('click', async () => {
      const agentId = button.dataset.disconnectAgent;
      button.disabled = true;
      try {
        await api(`/api/admin/agents/${encodeURIComponent(agentId)}/disconnect`, { method: 'POST' });
        setNotice('Agent disconnected. Send a new invite if they need to reconnect.', 'success');
        await loadState();
      } catch (error) {
        setNotice(`Disconnect failed: ${error.message}`, 'error');
      } finally {
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-delete-agent]').forEach((button) => {
    button.addEventListener('click', async () => {
      const agent = agents.find((item) => item.id === button.dataset.deleteAgent);
      const confirmed = window.confirm(
        `Delete ${agent?.name || 'this agent'}? Their login link will stop working. Existing call history will be kept.`
      );
      if (!confirmed) return;
      button.disabled = true;
      try {
        await api(`/api/admin/agents/${encodeURIComponent(button.dataset.deleteAgent)}`, { method: 'DELETE' });
        setNotice('Agent deleted. You can invite the same email again later.', 'success');
        await loadState();
      } catch (error) {
        setNotice(`Delete failed: ${error.message}`, 'error');
      } finally {
        button.disabled = false;
      }
    });
  });
}

async function loadSelectedCampaignSnapshot() {
  const campaign = selectedCampaign();
  if (!campaign) {
    selectedCampaignSnapshot = null;
    renderSelectedCampaign();
    return;
  }

  const requestId = ++snapshotRequestId;
  try {
    const snapshot = await api(
      `/api/campaigns/${campaign.id}?includeLeads=0`
    );
    if (requestId !== snapshotRequestId || selectedCampaignId !== campaign.id) return;

    selectedCampaignSnapshot = {
      ...snapshot,
      campaignId: campaign.id,
      loading: false
    };
    renderSelectedCampaign();
  } catch (error) {
    if (requestId !== snapshotRequestId || selectedCampaignId !== campaign.id) return;
    selectedCampaignSnapshot = {
      campaignId: campaign.id,
      loading: false,
      error: error.message
    };
    setNotice(`PowerList readiness check failed: ${error.message}`, 'error');
    renderSelectedCampaign();
  }
}

async function loadState(options = {}) {
  if (stateLoadInFlight) return;
  stateLoadInFlight = true;
  try {
    const statePath = options.refreshCallerIds
      ? '/api/state?refreshCallerIds=1'
      : '/api/state';
    if (!setup || options.refreshSetup) {
      [state, setup] = await Promise.all([api(statePath), api('/api/setup')]);
    } else {
      state = await api(statePath);
    }
    render();
    await loadSelectedCampaignSnapshot();
  } finally {
    stateLoadInFlight = false;
  }
}

function render() {
  setView(activeView);
  renderVerifiedCallerIds();
  renderDispositionOptions();
  renderOwners();
  renderStats();
  renderCampaigns();
  renderSelectedCampaign();
  renderCalls();
  renderEvents();
  renderSetup();
  renderDisposition();
  renderReports();
  renderHistory();
  renderAgents();
  renderDnc();
}

elements.navButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setView(button.dataset.view);
  });
});

elements.ownerSelect.addEventListener('change', () => {
  const owner = state.owners.find((item) => item.id === elements.ownerSelect.value);
  const agent = state.agents.find((item) => (
    item.ownerId === owner?.id
    || String(item.hubspotOwnerId || '') === String(owner?.hubspotOwnerId || '')
  ));
  document.querySelector('#agentPhone').value = owner?.agentPhone || '';
  elements.campaignCallerId.value = agent?.callerIdNumber || '';
});

elements.campaignForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(elements.campaignForm);
  try {
    const campaign = await api('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(form))
    });
    selectedCampaignId = campaign.id;
    let syncMessage = '';
    if (state.settings.leadSource === 'hubspot') {
      try {
        const syncResult = await api(`/api/campaigns/${campaign.id}/sync-hubspot`, { method: 'POST' });
        syncMessage = hubspotSyncMessage(syncResult);
      } catch (error) {
        syncMessage = `HubSpot sync failed: ${error.message}`;
      }
    }
    setNotice(
      `PowerList created with caller ID ${campaign.callerIdNumber}. ${syncMessage}`.trim(),
      syncMessage.startsWith('HubSpot sync failed:') ? 'error' : 'success'
    );
    await loadState();
  } catch (error) {
    setNotice(`PowerList creation failed: ${error.message}`, 'error');
  }
});

elements.agentInviteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(elements.agentInviteForm);

  try {
    const result = await api('/api/admin/agents/invite', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(form))
    });
    elements.agentInviteForm.reset();
      setNotice(
        result.invite?.emailSent
          ? `Invitation emailed to ${result.agent.email}.`
          : `Invitation created for ${result.agent.email}. Copy the web login link from the Agents table.`,
        result.invite?.emailSent ? 'success' : 'info'
      );
    await loadState();
    setView('agents');
  } catch (error) {
    setNotice(`Invite failed: ${error.message}`, 'error');
  }
});

elements.historySearch.addEventListener('input', renderHistory);

elements.dispositionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const callId = elements.dispositionForm.dataset.callId;
  if (!callId) return;
  const submitButton = elements.dispositionForm.querySelector('button[type="submit"]');
  const originalText = submitButton?.textContent || 'Save outcome';

  try {
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Saving...';
    }
    const result = await api(`/api/calls/${callId}/disposition`, {
      method: 'POST',
      body: JSON.stringify({
        status: elements.dispositionStatus.value,
        note: elements.dispositionNote.value
      })
    });
    elements.dispositionForm.reset();
    const warning = hubspotUpdateWarning(result);
    setNotice(
      warning
        ? `Outcome saved locally, but HubSpot reported: ${warning}`
        : (hubspotSyncQueued(result)
          ? 'Outcome saved. Dialing is resuming now while HubSpot sync finishes in the background.'
          : 'Outcome saved. Dialing is resuming now.'),
      warning ? 'error' : 'success'
    );
    await loadState();
  } catch (error) {
    setNotice(`Status save failed: ${error.message}`, 'error');
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = originalText;
    }
  }
});

elements.refreshButton.addEventListener('click', loadState);

elements.refreshCallerIdsButton.addEventListener('click', async () => {
  elements.refreshCallerIdsButton.disabled = true;
  try {
    await loadState({ refreshCallerIds: true });
    const callerIds = verifiedCallerIds();
    setNotice(
      `Loaded ${callerIds.length} verified caller ID${callerIds.length === 1 ? '' : 's'} directly from Plivo.`,
      'success'
    );
  } catch (error) {
    setNotice(`Plivo number refresh failed: ${error.message}`, 'error');
  } finally {
    elements.refreshCallerIdsButton.disabled = false;
  }
});

elements.syncOwnersButton.addEventListener('click', async () => {
  try {
    const result = await api('/api/hubspot/owners/sync', { method: 'POST' });
    setNotice(`Synced ${result.count || 0} HubSpot owner(s).`, 'success');
    await loadState();
  } catch (error) {
    setNotice(`Owner sync failed: ${error.message}`, 'error');
  }
});

elements.dncForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await api('/api/dnc', {
    method: 'POST',
    body: JSON.stringify({
      phone: elements.dncPhone.value,
      reason: elements.dncReason.value || 'Manual opt-out'
    })
  });
  elements.dncForm.reset();
  await loadState();
});

elements.startButton.addEventListener('click', async () => {
  const campaign = selectedCampaign();
  if (!campaign) return;
  try {
    await api(`/api/campaigns/${campaign.id}/start`, { method: 'POST' });
    setNotice('Campaign started and dial attempt checked. Review Active Calls, Recent Calls, or Dial Check below.', 'success');
    await loadState();
  } catch (error) {
    setNotice(`Start failed: ${error.message}`, 'error');
  }
});

elements.stopButton.addEventListener('click', async () => {
  const campaign = selectedCampaign();
  if (!campaign) return;
  try {
    await api(`/api/campaigns/${campaign.id}/stop`, { method: 'POST' });
    setNotice('Campaign stopped.', 'success');
    await loadState();
  } catch (error) {
    setNotice(`Stop failed: ${error.message}`, 'error');
  }
});

elements.deleteCampaignButton.addEventListener('click', async () => {
  const campaign = selectedCampaign();
  if (!campaign) return;
  const confirmed = window.confirm(`Delete PowerList "${campaign.name}"? This removes it from the dialer but keeps old call history.`);
  if (!confirmed) return;

  try {
    await api(`/api/campaigns/${campaign.id}`, { method: 'DELETE' });
    selectedCampaignId = '';
    setNotice('PowerList deleted.', 'success');
    await loadState();
  } catch (error) {
    setNotice(`Delete failed: ${error.message}`, 'error');
  }
});

elements.selectedCampaignLines.addEventListener('input', () => {
  campaignSettingsDraft = {
    campaignId: selectedCampaign()?.id || '',
    dirty: true
  };
});

elements.selectedCampaignCallerId.addEventListener('input', () => {
  campaignSettingsDraft = {
    campaignId: selectedCampaign()?.id || '',
    dirty: true
  };
});

elements.updateCampaignButton.addEventListener('click', async () => {
  const campaign = selectedCampaign();
  if (!campaign) return;
  try {
    const maxParallelCalls = Number(elements.selectedCampaignLines.value);
    if (!Number.isInteger(maxParallelCalls) || maxParallelCalls < 1 || maxParallelCalls > 10) {
      throw new Error('Lines must be a whole number from 1 to 10.');
    }

    const currentCallerId = campaign.callerIdNumber || campaign.callerIdNumbers?.[0] || '';
    const nextCallerId = String(elements.selectedCampaignCallerId.value || '').trim();
    const patch = {};
    if (maxParallelCalls !== Number(campaign.maxParallelCalls || 1)) {
      patch.maxParallelCalls = maxParallelCalls;
    }
    if (nextCallerId !== currentCallerId) {
      patch.callerIdNumber = nextCallerId;
    }
    if (!Object.keys(patch).length) {
      campaignSettingsDraft.dirty = false;
      setNotice('PowerList settings are already up to date.', 'info');
      return;
    }

    const updated = await api(`/api/campaigns/${campaign.id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    });
    campaignSettingsDraft = {
      campaignId: campaign.id,
      dirty: false
    };
    setNotice(`PowerList updated to ${updated.maxParallelCalls} line${updated.maxParallelCalls === 1 ? '' : 's'}.`, 'success');
    await loadState();
  } catch (error) {
    setNotice(`PowerList update failed: ${error.message}`, 'error');
  }
});

elements.syncHubSpotButton.addEventListener('click', async () => {
  const campaign = selectedCampaign();
  if (!campaign) return;
  try {
    const result = await api(`/api/campaigns/${campaign.id}/sync-hubspot`, { method: 'POST' });
    const count = result.count || 0;
    const resetCount = result.providerErrorsReset || 0;
    setNotice(hubspotSyncMessage(result), count || resetCount ? 'success' : 'info');
    await loadState();
  } catch (error) {
    setNotice(`HubSpot sync failed: ${error.message}`, 'error');
  }
});

elements.resetProviderErrorsButton.addEventListener('click', async () => {
  const campaign = selectedCampaign();
  if (!campaign) return;
  try {
    const result = await api(`/api/campaigns/${campaign.id}/reset-provider-errors`, { method: 'POST' });
    setNotice(
      result.reset
        ? `Cleared ${result.reset} provider error lead(s). Try Start again with 1 line.`
        : 'No provider errors to clear.',
      result.reset ? 'success' : 'info'
    );
    await loadState();
  } catch (error) {
    setNotice(`Retry reset failed: ${error.message}`, 'error');
  }
});

await loadState();
setInterval(() => {
  loadState().catch((error) => {
    setNotice(`Dashboard refresh failed: ${error.message}`, 'error');
  });
}, 5000);
