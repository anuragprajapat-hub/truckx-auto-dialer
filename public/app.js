let state = null;
let setup = null;
let selectedCampaignId = '';

const elements = {
  systemLine: document.querySelector('#systemLine'),
  statCampaigns: document.querySelector('#statCampaigns'),
  statActive: document.querySelector('#statActive'),
  statConnected: document.querySelector('#statConnected'),
  statVm: document.querySelector('#statVm'),
  ownerSelect: document.querySelector('#ownerSelect'),
  syncOwnersButton: document.querySelector('#syncOwnersButton'),
  campaignForm: document.querySelector('#campaignForm'),
  campaignList: document.querySelector('#campaignList'),
  activeCampaignName: document.querySelector('#activeCampaignName'),
  activeCampaignMeta: document.querySelector('#activeCampaignMeta'),
  leadRows: document.querySelector('#leadRows'),
  activeCalls: document.querySelector('#activeCalls'),
  callLog: document.querySelector('#callLog'),
  eventLog: document.querySelector('#eventLog'),
  setupStatus: document.querySelector('#setupStatus'),
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

  elements.systemLine.textContent = `Provider: ${state.settings.voiceProvider} | Lead source: ${state.settings.leadSource} | Caller IDs: ${state.settings.callerIdNumbers.length}`;
  elements.statCampaigns.textContent = state.campaigns.length;
  elements.statActive.textContent = activeCalls.length;
  elements.statConnected.textContent = connected;
  elements.statVm.textContent = vm;
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
          <span>${escapeHtml(owner?.name || 'Unknown owner')} | ${campaign.maxParallelCalls} lines | ${campaign.status}</span>
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
  const campaignLeads = state.leads.filter((lead) => lead.ownerId === campaign.ownerId);
  elements.activeCampaignName.textContent = campaign.name;
  elements.activeCampaignMeta.textContent = `${owner?.name || 'Owner'} | ${campaign.status} | ${campaign.callWindowStart}-${campaign.callWindowEnd} local`;
  elements.startButton.disabled = campaign.status === 'running';
  elements.stopButton.disabled = campaign.status !== 'running';
  elements.syncHubSpotButton.disabled = state.settings.leadSource !== 'hubspot';

  if (!campaignLeads.length) {
    elements.leadRows.innerHTML = '<tr><td colspan="6">No leads for this owner.</td></tr>';
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
          <td>${escapeHtml(lead.timeZone || '')}</td>
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

elements.refreshButton.addEventListener('click', loadState);

elements.syncOwnersButton.addEventListener('click', async () => {
  await api('/api/hubspot/owners/sync', { method: 'POST' });
  await loadState();
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
  await api(`/api/campaigns/${campaign.id}/start`, { method: 'POST' });
  await loadState();
});

elements.stopButton.addEventListener('click', async () => {
  const campaign = selectedCampaign();
  if (!campaign) return;
  await api(`/api/campaigns/${campaign.id}/stop`, { method: 'POST' });
  await loadState();
});

elements.syncHubSpotButton.addEventListener('click', async () => {
  const campaign = selectedCampaign();
  if (!campaign) return;
  await api(`/api/campaigns/${campaign.id}/sync-hubspot`, { method: 'POST' });
  await loadState();
});

await loadState();
setInterval(loadState, 2500);
