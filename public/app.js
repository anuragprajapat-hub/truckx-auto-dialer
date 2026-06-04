let state = null;
let setup = null;
let selectedCampaignId = '';
let activeView = 'powerlists';

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
  campaignList: document.querySelector('#campaignList'),
  activeCampaignName: document.querySelector('#activeCampaignName'),
  activeCampaignMeta: document.querySelector('#activeCampaignMeta'),
  notice: document.querySelector('#notice'),
  queueHealth: document.querySelector('#queueHealth'),
  leadRows: document.querySelector('#leadRows'),
  activeCalls: document.querySelector('#activeCalls'),
  callLog: document.querySelector('#callLog'),
  eventLog: document.querySelector('#eventLog'),
  setupStatus: document.querySelector('#setupStatus'),
  agentReports: document.querySelector('#agentReports'),
  reportRows: document.querySelector('#reportRows'),
  historyRows: document.querySelector('#historyRows'),
  historySearch: document.querySelector('#historySearch'),
  agentInviteForm: document.querySelector('#agentInviteForm'),
  agentOwnerSelect: document.querySelector('#agentOwnerSelect'),
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
  refreshButton: document.querySelector('#refreshButton'),
  startButton: document.querySelector('#startButton'),
  stopButton: document.querySelector('#stopButton'),
  deleteCampaignButton: document.querySelector('#deleteCampaignButton'),
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
  return `<span class="pill ${escapeHtml(clean)} ${extraClass}">${escapeHtml(clean.replaceAll('_', ' '))}</span>`;
}

function campaignTarget(campaign) {
  const target = String(campaign?.timeZoneTarget || 'ALL').toUpperCase();
  return ['EST', 'CST', 'MST', 'PST'].includes(target) ? target : 'ALL';
}

function leadZone(lead) {
  const value = String(lead.timeZoneLabel || lead.timeZone || '').trim();
  const ianaMap = {
    'America/New_York': 'EST',
    'America/Chicago': 'CST',
    'America/Denver': 'MST',
    'America/Phoenix': 'MST',
    'America/Los_Angeles': 'PST'
  };
  return ianaMap[value] || value.toUpperCase();
}

function leadMatchesCampaign(lead, campaign) {
  const target = campaignTarget(campaign);
  const zone = leadZone(lead);
  return target === 'ALL' || zone === target || zone === 'UNASSIGNED';
}

function queueSummary(leads) {
  const summary = {
    total: leads.length,
    ready: 0,
    blocked: 0,
    topReason: '',
    topReasonCount: 0
  };
  const reasons = new Map();

  for (const lead of leads) {
    if (lead.dialCheck?.allowed) {
      summary.ready += 1;
      continue;
    }

    summary.blocked += 1;
    const reason = lead.dialCheck?.reason || 'Not ready';
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }

  for (const [reason, count] of reasons.entries()) {
    if (count > summary.topReasonCount) {
      summary.topReason = reason;
      summary.topReasonCount = count;
    }
  }

  return summary;
}

function nextQueueAction(summary) {
  if (!summary.total) return 'Sync HubSpot or create a PowerList with matching owner and timezone.';
  if (summary.ready) return `${summary.ready} lead${summary.ready === 1 ? '' : 's'} ready for dialing.`;

  const reason = String(summary.topReason || '').toLowerCase();
  if (reason.includes('provider error')) return 'If carrier approval is complete, click Retry Errors and then Start.';
  if (reason.includes('consent')) return 'Update Dialer consent to Yes in HubSpot, then sync.';
  if (reason.includes('do not call') || reason.includes('dnc')) return 'Review the DNC or do_not_call value before dialing.';
  if (reason.includes('attempt')) return 'Use a fresh test contact or raise MAX_ATTEMPTS_PER_LEAD for testing.';
  if (reason.includes('phone')) return 'Fix the contact phone number in HubSpot.';
  if (reason.includes('campaign')) return 'Change the PowerList timezone or the contact TIME ZONE value.';
  return summary.topReason || 'Queue is not ready.';
}

function renderQueueHealth(leads, campaign) {
  if (!elements.queueHealth) return;
  if (!campaign) {
    elements.queueHealth.hidden = true;
    elements.queueHealth.innerHTML = '';
    return;
  }

  const summary = queueSummary(leads);
  const readyClass = summary.ready ? 'ready' : 'blocked';
  const topReason = summary.topReason
    ? `${summary.topReasonCount} blocked: ${summary.topReason}`
    : 'No blockers';

  elements.queueHealth.hidden = false;
  elements.queueHealth.innerHTML = `
    <div class="queue-metrics">
      <div>
        <strong>${escapeHtml(summary.total)}</strong>
        <span>Total leads</span>
      </div>
      <div>
        <strong>${escapeHtml(summary.ready)}</strong>
        <span>Ready now</span>
      </div>
      <div>
        <strong>${escapeHtml(summary.blocked)}</strong>
        <span>Blocked</span>
      </div>
    </div>
    <div class="queue-action ${readyClass}">
      <strong>${summary.ready ? 'Ready to start' : 'Needs attention'}</strong>
      <span>${escapeHtml(topReason)}</span>
      <span>${escapeHtml(nextQueueAction(summary))}</span>
    </div>
  `;
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
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
}

function renderStats() {
  const activeCalls = state.calls.filter((call) => ['dialing', 'queued', 'ringing', 'in_progress'].includes(call.status));
  const connected = state.calls.filter((call) => call.outcome === 'live_answer').length;
  const vm = state.calls.filter((call) => call.outcome === 'voicemail').length;
  const reports = state.reports?.agents || [];
  const dialerSeconds = reports.reduce((sum, report) => sum + Number(report.dialerSeconds || 0), 0);

  const providerAccount = state.settings.providerAccount ? ` (${state.settings.providerAccount})` : '';
  elements.systemLine.textContent = `Provider: ${state.settings.voiceProvider}${providerAccount} | Lead source: ${state.settings.leadSource} | Caller IDs: ${state.settings.callerIdNumbers.length}`;
  elements.statCampaigns.textContent = activeCampaigns().length;
  elements.statDials.textContent = state.calls.length;
  elements.statActive.textContent = activeCalls.length;
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
      return `
        <button class="campaign-item ${active}" data-campaign-id="${escapeHtml(campaign.id)}">
          <strong>${escapeHtml(campaign.name)}</strong>
          <span>${escapeHtml(owner?.name || 'Unknown owner')} | ${campaignTarget(campaign)} | ${campaign.maxParallelCalls} lines | ${campaign.status}</span>
        </button>
      `;
    })
    .join('');

  document.querySelectorAll('.campaign-item').forEach((button) => {
    button.addEventListener('click', () => {
      selectedCampaignId = button.dataset.campaignId;
      render();
    });
  });
}

function renderSelectedCampaign() {
  const campaign = selectedCampaign();
  if (!campaign) {
    elements.activeCampaignName.textContent = 'Queue';
    elements.activeCampaignMeta.textContent = 'No campaign selected';
    renderQueueHealth([], null);
    elements.leadRows.innerHTML = '<tr><td colspan="6">Create a campaign to load the queue.</td></tr>';
    elements.startButton.disabled = true;
    elements.stopButton.disabled = true;
    elements.deleteCampaignButton.disabled = true;
    elements.syncHubSpotButton.disabled = true;
    elements.resetProviderErrorsButton.disabled = true;
    return;
  }

  const owner = state.owners.find((item) => item.id === campaign.ownerId);
  const campaignLeads = state.leads
    .filter((lead) => lead.ownerId === campaign.ownerId)
    .filter((lead) => leadMatchesCampaign(lead, campaign));
  const summary = queueSummary(campaignLeads);
  elements.activeCampaignName.textContent = campaign.name;
  elements.activeCampaignMeta.textContent = `${owner?.name || 'Owner'} | ${campaign.status} | ${campaignTarget(campaign)} | ${campaign.maxParallelCalls} lines`;
  elements.startButton.disabled = ['running', 'connected'].includes(campaign.status) || summary.ready === 0;
  elements.stopButton.disabled = !['running', 'connected', 'paused'].includes(campaign.status);
  elements.deleteCampaignButton.disabled = false;
  elements.syncHubSpotButton.disabled = state.settings.leadSource !== 'hubspot';
  elements.resetProviderErrorsButton.disabled = !campaignLeads.some((lead) => lead.status === 'provider_error');
  renderQueueHealth(campaignLeads, campaign);

  if (!campaignLeads.length) {
    elements.leadRows.innerHTML = '<tr><td colspan="6">No leads match this owner and timezone.</td></tr>';
    return;
  }

  elements.leadRows.innerHTML = campaignLeads
    .map((lead) => {
      const check = lead.dialCheck || {};
      const allowed = check.allowed ? statusPill('allowed', 'allowed') : statusPill('blocked', 'blocked');
      return `
        <tr>
          <td>
            <div class="lead-name">
              <strong>${escapeHtml(lead.name)}</strong>
              <span>${escapeHtml(lead.company || lead.email || '')}</span>
            </div>
          </td>
          <td>${escapeHtml(lead.phone)}</td>
          <td>${escapeHtml(lead.timeZoneLabel || lead.timeZone || '')}</td>
          <td>${statusPill(lead.status)}</td>
          <td>${escapeHtml(lead.attempts || 0)}</td>
          <td>${allowed}<br><span>${escapeHtml(check.reason || '')}</span></td>
        </tr>
      `;
    })
    .join('');
}

function renderCalls() {
  const campaign = selectedCampaign();
  const activeStatuses = ['dialing', 'queued', 'ringing', 'in_progress'];
  const activeCalls = state.calls.filter((call) => (!campaign || call.campaignId === campaign.id) && activeStatuses.includes(call.status));
  const logs = state.calls.filter((call) => !campaign || call.campaignId === campaign.id).slice(0, 12);

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
}

function renderEvents() {
  elements.eventLog.innerHTML = state.events.length
    ? state.events
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
            <td>${escapeHtml(formatDuration(report.dialerSeconds))}</td>
          </tr>
        `)
        .join('')
    : '<tr><td colspan="6">No agent activity yet.</td></tr>';
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
  elements.agentRows.innerHTML = agents.length
    ? agents
        .map((agent) => {
          const invite = latestInviteForAgent(agent);
          const inviteCell = invite?.inviteUrl
            ? `
              <div class="invite-actions">
                <button type="button" data-copy-invite="${escapeHtml(invite.inviteUrl)}">Copy invite link</button>
                <span>${escapeHtml(inviteEmailStatus(invite))}</span>
              </div>
            `
            : '<span class="muted">No invite</span>';
          const canDisconnect = agent.extensionStatus !== 'disconnected'
            && (agent.extensionStatus === 'connected' || agent.status === 'active' || Boolean(agent.lastSeenAt));
          const actionCell = canDisconnect
            ? `<button class="danger-outline-button" type="button" data-disconnect-agent="${escapeHtml(agent.id)}">Disconnect</button>`
            : '<span class="muted">No active session</span>';
          return `
            <tr>
              <td>${escapeHtml(agent.name)}</td>
              <td>${escapeHtml(agent.email)}</td>
              <td>${escapeHtml(agent.hubspotOwnerId || agent.ownerId || '')}</td>
              <td>${statusPill(agent.status || 'invited')}</td>
              <td>${statusPill(agent.extensionStatus || 'not_installed')}</td>
              <td>${inviteCell}</td>
              <td>${actionCell}</td>
            </tr>
          `;
        })
        .join('')
    : '<tr><td colspan="7">No invited agents yet.</td></tr>';

  document.querySelectorAll('[data-copy-invite]').forEach((button) => {
    button.addEventListener('click', async () => {
      await copyText(button.dataset.copyInvite);
      setNotice('Invite link copied.', 'success');
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
}

async function loadState() {
  [state, setup] = await Promise.all([api('/api/state'), api('/api/setup')]);
  const campaign = selectedCampaign();
  if (campaign) {
    const snapshot = await api(`/api/campaigns/${campaign.id}`);
    state.leads = state.leads.map((lead) => {
      const enriched = snapshot.leads.find((item) => item.id === lead.id);
      return enriched || lead;
    });
  }
  render();
}

function render() {
  setView(activeView);
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
  document.querySelector('#agentPhone').value = owner?.agentPhone || '';
});

elements.campaignForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(elements.campaignForm);
  const campaign = await api('/api/campaigns', {
    method: 'POST',
    body: JSON.stringify(Object.fromEntries(form))
  });
  selectedCampaignId = campaign.id;
  await loadState();
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
        : `Invitation created for ${result.agent.email}. Copy the invite link from the Agents table.`,
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

  try {
    await api(`/api/calls/${callId}/disposition`, {
      method: 'POST',
      body: JSON.stringify({
        status: elements.dispositionStatus.value,
        note: elements.dispositionNote.value
      })
    });
    elements.dispositionForm.reset();
    setNotice('Lead status saved. Press Start when the agent is ready to keep dialing.', 'success');
    await loadState();
  } catch (error) {
    setNotice(`Status save failed: ${error.message}`, 'error');
  }
});

elements.refreshButton.addEventListener('click', loadState);

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

elements.syncHubSpotButton.addEventListener('click', async () => {
  const campaign = selectedCampaign();
  if (!campaign) return;
  try {
    const result = await api(`/api/campaigns/${campaign.id}/sync-hubspot`, { method: 'POST' });
    const count = result.count || 0;
    const resetCount = result.providerErrorsReset || 0;
    setNotice(
      [
        count
          ? `Synced ${count} HubSpot contact(s) for this owner.`
          : 'Synced HubSpot, but found 0 contacts for this owner. Check that contacts have this HubSpot owner.',
        resetCount ? `Cleared ${resetCount} old provider error lead(s).` : ''
      ].filter(Boolean).join(' '),
      count || resetCount ? 'success' : 'info'
    );
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
setInterval(loadState, 2500);
