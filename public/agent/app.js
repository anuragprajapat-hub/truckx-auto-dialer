const TOKEN_KEY = 'truckxAgentToken';
const ACTIVE_STATUSES = new Set(['dialing', 'queued', 'ringing', 'in_progress']);
const REQUEST_TIMEOUT_MS = 70000;

let authToken = '';
let state = null;
let snapshot = null;
let selectedCampaignId = '';

const elements = {
  setupView: document.querySelector('#setupView'),
  agentView: document.querySelector('#agentView'),
  manualToken: document.querySelector('#manualToken'),
  manualConnectButton: document.querySelector('#manualConnectButton'),
  logoutButton: document.querySelector('#logoutButton'),
  setupMessage: document.querySelector('#setupMessage'),
  agentName: document.querySelector('#agentName'),
  agentEmail: document.querySelector('#agentEmail'),
  statCalls: document.querySelector('#statCalls'),
  statConnected: document.querySelector('#statConnected'),
  statVm: document.querySelector('#statVm'),
  statActive: document.querySelector('#statActive'),
  statTime: document.querySelector('#statTime'),
  notice: document.querySelector('#notice'),
  campaignSelect: document.querySelector('#campaignSelect'),
  campaignMeta: document.querySelector('#campaignMeta'),
  campaignStatus: document.querySelector('#campaignStatus'),
  startButton: document.querySelector('#startButton'),
  stopButton: document.querySelector('#stopButton'),
  dispositionPanel: document.querySelector('#dispositionPanel'),
  dispositionLead: document.querySelector('#dispositionLead'),
  dispositionForm: document.querySelector('#dispositionForm'),
  dispositionStatus: document.querySelector('#dispositionStatus'),
  dispositionNote: document.querySelector('#dispositionNote'),
  leadRows: document.querySelector('#leadRows'),
  activeCalls: document.querySelector('#activeCalls'),
  recentCalls: document.querySelector('#recentCalls')
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setToken(token) {
  authToken = String(token || '').trim();
  if (authToken) localStorage.setItem(TOKEN_KEY, authToken);
}

async function fetchJson(path, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(path, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(options.headers || {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Request failed with ${response.status}`);
    }
    return body;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Connection timed out. The server may still be waking up; wait a few seconds and try again.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function initialToken() {
  const params = new URLSearchParams(window.location.search);
  const queryToken = params.get('token') || '';
  if (queryToken) {
    window.history.replaceState({}, '', '/agent/');
    return queryToken;
  }
  return localStorage.getItem(TOKEN_KEY) || '';
}

async function exchangeInviteToken(inviteToken) {
  await fetchJson(`/api/invites/${encodeURIComponent(inviteToken)}`, {
    headers: {}
  });
  const body = await fetchJson(`/api/invites/${encodeURIComponent(inviteToken)}/accept`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  return body.token;
}

async function connectWithToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) {
    showSetup('Setup token is required.');
    return;
  }
  const apiToken = token.startsWith('txa_') ? token : await exchangeInviteToken(token);
  setToken(apiToken);
  await loadState();
}

async function api(path, options = {}) {
  return fetchJson(path, options);
}

function showSetup(message = '') {
  elements.setupView.hidden = false;
  elements.agentView.hidden = true;
  elements.setupMessage.textContent = message;
}

function setConnectBusy(isBusy, message = '') {
  elements.manualConnectButton.disabled = isBusy;
  elements.manualConnectButton.textContent = isBusy ? 'Connecting...' : 'Connect';
  elements.setupMessage.textContent = message;
}

function setupErrorMessage(error) {
  if (error.message === 'Invite not found') {
    return 'Invite not found. Ask admin to create a new invite and use the new setup token.';
  }
  if (error.message === 'Invite is no longer active') {
    return 'This invite was already used. Ask admin for the latest setup link, or open the dialer from the connected extension.';
  }
  if (error.message === 'Authentication required') {
    return 'Agent session is not connected. Paste the latest setup token and connect again.';
  }
  return error.message;
}

function showAgent() {
  elements.setupView.hidden = true;
  elements.agentView.hidden = false;
}

function logout(message = 'Logged out. Paste a setup token to connect again.') {
  authToken = '';
  state = null;
  snapshot = null;
  selectedCampaignId = '';
  localStorage.removeItem(TOKEN_KEY);
  elements.manualToken.value = '';
  showSetup(message);
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

function statusPill(value, extraClass = '') {
  const clean = String(value || 'unknown');
  return `<span class="pill ${escapeHtml(clean)} ${extraClass}">${escapeHtml(clean.replaceAll('_', ' '))}</span>`;
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function selectedCampaign() {
  if (!state?.campaigns?.length) return null;
  return state.campaigns.find((campaign) => campaign.id === selectedCampaignId) || state.campaigns[0];
}

function campaignTarget(campaign) {
  const target = String(campaign?.timeZoneTarget || 'ALL').toUpperCase();
  return ['EST', 'CST', 'MST', 'PST'].includes(target) ? target : 'ALL';
}

function pendingDispositionCall() {
  const campaign = selectedCampaign();
  if (!campaign) return null;
  return state.calls.find((call) => call.campaignId === campaign.id && call.requiresDisposition);
}

function renderHeader() {
  const agent = state.agents?.[0] || {};
  const owner = state.owners?.[0] || {};
  elements.agentName.textContent = agent.name || owner.name || 'Agent';
  elements.agentEmail.textContent = agent.email || state.currentUser?.email || owner.email || '';
}

function renderStats() {
  const report = state.reports?.agents?.[0] || {};
  elements.statCalls.textContent = report.totalCalls || 0;
  elements.statConnected.textContent = report.connected || 0;
  elements.statVm.textContent = report.voicemail || 0;
  elements.statActive.textContent = report.activeCalls || 0;
  elements.statTime.textContent = formatDuration(report.dialerSeconds || 0);
}

function renderCampaigns() {
  if (!state.campaigns.length) {
    elements.campaignSelect.innerHTML = '<option value="">No PowerLists</option>';
    selectedCampaignId = '';
    elements.campaignMeta.textContent = 'No PowerList assigned. Ask admin to create and sync one.';
    elements.campaignStatus.outerHTML = '<span id="campaignStatus" class="pill">idle</span>';
    elements.campaignStatus = document.querySelector('#campaignStatus');
    elements.startButton.disabled = true;
    elements.stopButton.disabled = true;
    return;
  }

  const current = selectedCampaign();
  selectedCampaignId = current.id;
  elements.campaignSelect.innerHTML = state.campaigns
    .map((campaign) => `<option value="${escapeHtml(campaign.id)}">${escapeHtml(campaign.name)}</option>`)
    .join('');
  elements.campaignSelect.value = selectedCampaignId;
  elements.campaignMeta.textContent = `${campaignTarget(current)} | ${current.maxParallelCalls} lines | ${current.callWindowStart}-${current.callWindowEnd} local`;
  elements.campaignStatus.outerHTML = statusPill(current.status || 'draft');
  elements.campaignStatus = document.querySelector('.panel-heading .pill');
  elements.startButton.disabled = ['running', 'connected'].includes(current.status);
  elements.stopButton.disabled = !['running', 'connected', 'paused'].includes(current.status);
}

function renderLeads() {
  const leads = snapshot?.leads || [];
  if (!selectedCampaign()) {
    elements.leadRows.innerHTML = '<tr><td colspan="6">No PowerList selected.</td></tr>';
    return;
  }
  if (!leads.length) {
    elements.leadRows.innerHTML = '<tr><td colspan="6">No leads in this PowerList.</td></tr>';
    return;
  }

  elements.leadRows.innerHTML = leads
    .map((lead) => {
      const check = lead.dialCheck || {};
      const allowed = check.allowed ? statusPill('allowed', 'allowed') : statusPill('blocked', 'blocked');
      return `
        <tr>
          <td>
            <div class="lead-cell">
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

function renderCalls() {
  const campaign = selectedCampaign();
  const calls = state.calls.filter((call) => !campaign || call.campaignId === campaign.id);
  const activeCalls = calls.filter((call) => ACTIVE_STATUSES.has(call.status));
  elements.activeCalls.innerHTML = activeCalls.length
    ? activeCalls.map((call) => `
      <div class="call-card">
        <strong>${escapeHtml(call.leadName)}</strong>
        <span>${escapeHtml(call.leadPhone)} | attempt ${escapeHtml(call.attempt)}</span>
        ${statusPill(call.status)}
      </div>
    `).join('')
    : '<div class="empty">No active calls</div>';

  elements.recentCalls.innerHTML = calls.slice(0, 8).length
    ? calls.slice(0, 8).map((call) => `
      <div class="call-card">
        <strong>${escapeHtml(call.leadName)}</strong>
        <span>${escapeHtml(call.leadPhone)} | ${escapeHtml(new Date(call.startedAt).toLocaleTimeString())}</span>
        ${statusPill(call.outcome || call.status)}
      </div>
    `).join('')
    : '<div class="empty">No calls yet</div>';
}

function render() {
  showAgent();
  renderHeader();
  renderStats();
  renderCampaigns();
  renderLeads();
  renderDisposition();
  renderCalls();
}

async function loadState() {
  state = await api('/api/state');
  const campaign = selectedCampaign();
  snapshot = campaign ? await api(`/api/campaigns/${campaign.id}`) : null;
  render();
}

elements.manualConnectButton.addEventListener('click', async () => {
  const slowMessageTimer = window.setTimeout(() => {
    elements.setupMessage.textContent = 'Still connecting. Render free instances can take a little time to wake up.';
  }, 8000);

  try {
    setConnectBusy(true, 'Connecting to TruckX Auto Dialer...');
    await connectWithToken(elements.manualToken.value);
    setNotice('Connected.', 'success');
  } catch (error) {
    localStorage.removeItem(TOKEN_KEY);
    showSetup(setupErrorMessage(error));
  } finally {
    window.clearTimeout(slowMessageTimer);
    setConnectBusy(false, elements.setupMessage.textContent);
  }
});

elements.campaignSelect.addEventListener('change', async () => {
  selectedCampaignId = elements.campaignSelect.value;
  await loadState();
});

elements.startButton.addEventListener('click', async () => {
  const campaign = selectedCampaign();
  if (!campaign) return;
  try {
    await api(`/api/campaigns/${campaign.id}/start`, { method: 'POST' });
    setNotice('Dialer started.', 'success');
    await loadState();
  } catch (error) {
    setNotice(error.message, 'error');
  }
});

elements.stopButton.addEventListener('click', async () => {
  const campaign = selectedCampaign();
  if (!campaign) return;
  try {
    await api(`/api/campaigns/${campaign.id}/stop`, { method: 'POST' });
    setNotice('Dialer stopped.', 'success');
    await loadState();
  } catch (error) {
    setNotice(error.message, 'error');
  }
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
    setNotice('Lead status saved.', 'success');
    await loadState();
  } catch (error) {
    setNotice(error.message, 'error');
  }
});

elements.logoutButton.addEventListener('click', async () => {
  const token = authToken;
  try {
    if (token) {
      await api('/api/extension/logout', { method: 'POST' });
    }
  } catch {
    // Local logout still matters even if the server session already expired.
  } finally {
    logout();
  }
});

const bootToken = initialToken();
if (!bootToken) {
  showSetup();
} else {
  setConnectBusy(true, 'Connecting to TruckX Auto Dialer...');
  connectWithToken(bootToken).catch((error) => {
    localStorage.removeItem(TOKEN_KEY);
    showSetup(setupErrorMessage(error));
  }).finally(() => {
    setConnectBusy(false, elements.setupMessage.textContent);
  });
  setInterval(() => {
    if (!elements.agentView.hidden) {
      loadState().catch((error) => setNotice(error.message, 'error'));
    }
  }, 2500);
}
