let state = null;
let setup = null;
let selectedCampaignId = '';

const elements = {
  systemLine: document.querySelector('#systemLine'),
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
  leadRows: document.querySelector('#leadRows'),
  activeCalls: document.querySelector('#activeCalls'),
  callLog: document.querySelector('#callLog'),
  eventLog: document.querySelector('#eventLog'),
  setupStatus: document.querySelector('#setupStatus'),
  agentReports: document.querySelector('#agentReports'),
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
  return target === 'ALL' || leadZone(lead) === target;
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function pendingDispositionCall() {
  const campaign = selectedCampaign();
  if (!campaign) return null;
  return state.calls.find((call) => call.campaignId === campaign.id && call.requiresDisposition);
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
  if (!state?.campaigns?.length) return null;
  return state.campaigns.find((campaign) => campaign.id === selectedCampaignId) || state.campaigns[0];
}

function renderOwners() {
  const current = elements.ownerSelect.value;
  elements.ownerSelect.innerHTML = state.owners
    .map((owner) => `<option value="${escapeHtml(owner.id)}">${escapeHtml(owner.name)}</option>`)
    .join('');
  if (current) elements.ownerSelect.value = current;

  const owner = state.owners.find((item) => item.id === elements.ownerSelect.value);
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

  elements.systemLine.textContent = `Provider: ${state.settings.voiceProvider} | Lead source: ${state.settings.leadSource} | Caller IDs: ${state.settings.callerIdNumbers.length}`;
  elements.statCampaigns.textContent = state.campaigns.length;
  elements.statDials.textContent = state.calls.length;
  elements.statActive.textContent = activeCalls.length;
  elements.statConnected.textContent = connected;
  elements.statVm.textContent = vm;
  elements.statHours.textContent = formatDuration(dialerSeconds);
}

function renderCampaigns() {
  if (!state.campaigns.length) {
    elements.campaignList.innerHTML = '<div class="empty">No campaigns yet</div>';
    return;
  }

  const selected = selectedCampaign();
  selectedCampaignId = selected.id;

  elements.campaignList.innerHTML = state.campaigns
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
    elements.leadRows.innerHTML = '<tr><td colspan="6">Create a campaign to load the queue.</td></tr>';
    elements.startButton.disabled = true;
    elements.stopButton.disabled = true;
    elements.syncHubSpotButton.disabled = true;
    return;
  }

  const owner = state.owners.find((item) => item.id === campaign.ownerId);
  const campaignLeads = state.leads
    .filter((lead) => lead.ownerId === campaign.ownerId)
    .filter((lead) => leadMatchesCampaign(lead, campaign));
  elements.activeCampaignName.textContent = campaign.name;
  elements.activeCampaignMeta.textContent = `${owner?.name || 'Owner'} | ${campaign.status} | ${campaignTarget(campaign)} | ${campaign.maxParallelCalls} lines | ${campaign.callWindowStart}-${campaign.callWindowEnd} local`;
  elements.startButton.disabled = ['running', 'connected'].includes(campaign.status);
  elements.stopButton.disabled = !['running', 'connected', 'paused'].includes(campaign.status);
  elements.syncHubSpotButton.disabled = state.settings.leadSource !== 'hubspot';

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
  renderOwners();
  renderStats();
  renderCampaigns();
  renderSelectedCampaign();
  renderCalls();
  renderEvents();
  renderSetup();
  renderDisposition();
  renderReports();
  renderDnc();
}

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
    setNotice('Campaign started.', 'success');
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

elements.syncHubSpotButton.addEventListener('click', async () => {
  const campaign = selectedCampaign();
  if (!campaign) return;
  try {
    const result = await api(`/api/campaigns/${campaign.id}/sync-hubspot`, { method: 'POST' });
    const count = result.count || 0;
    setNotice(
      count
        ? `Synced ${count} HubSpot contact(s) for this owner.`
        : 'Synced HubSpot, but found 0 contacts for this owner. Check that contacts have this HubSpot owner.',
      count ? 'success' : 'info'
    );
    await loadState();
  } catch (error) {
    setNotice(`HubSpot sync failed: ${error.message}`, 'error');
  }
});

await loadState();
setInterval(loadState, 2500);
