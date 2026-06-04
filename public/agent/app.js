const TOKEN_KEY = 'truckxAgentToken';
const ACTIVE_STATUSES = new Set(['dialing', 'queued', 'ringing', 'in_progress']);
const REQUEST_TIMEOUT_MS = 70000;

let authToken = '';
let state = null;
let snapshot = null;
let selectedCampaignId = '';
let softphoneClient = null;
let softphoneLoggedIn = false;
let softphoneCallActive = false;
let softphoneLoginWaiter = null;
let softphoneMode = 'phone';
let softphoneConfigCache = null;
let activeDispositionCallId = '';
let softphoneStatus = {
  kind: 'idle',
  title: 'Browser audio not connected',
  message: 'Click Start Audio and allow microphone access. Plivo shows Registered only while this page is connected.'
};

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
  audioStatus: document.querySelector('#audioStatus'),
  dispositionPanel: document.querySelector('#dispositionPanel'),
  dispositionLead: document.querySelector('#dispositionLead'),
  dispositionForm: document.querySelector('#dispositionForm'),
  dispositionStatus: document.querySelector('#dispositionStatus'),
  dispositionNote: document.querySelector('#dispositionNote'),
  queueHealth: document.querySelector('#queueHealth'),
  leadRows: document.querySelector('#leadRows'),
  activeCalls: document.querySelector('#activeCalls'),
  recentCalls: document.querySelector('#recentCalls'),
  abandonedCalls: document.querySelector('#abandonedCalls')
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
  softphoneConfigCache = null;
  softphoneMode = 'phone';
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

function setSoftphoneStatus(title, message, kind = 'idle') {
  softphoneStatus = { title, message, kind };
  renderSoftphoneStatus();
}

async function softphoneConfig(options = {}) {
  if (softphoneConfigCache && !options.refresh) return softphoneConfigCache;
  const config = await api('/api/agent/softphone-config');
  softphoneConfigCache = config;
  softphoneMode = config.mode || 'phone';
  return config;
}

function settleSoftphoneLogin(error) {
  if (!softphoneLoginWaiter) return;
  if (error) {
    softphoneLoginWaiter.reject(error);
  } else {
    softphoneLoginWaiter.resolve();
  }
  softphoneLoginWaiter = null;
}

function initSoftphoneClient() {
  if (softphoneClient) return softphoneClient;
  if (!window.Plivo) {
    throw new Error('Browser phone is still loading. Wait a few seconds and press Start again.');
  }

  const sdk = new window.Plivo({
    debug: 'INFO',
    permOnClick: true,
    enableTracking: true,
    closeProtection: true,
    maxAverageBitrate: 48000
  });

  softphoneClient = sdk.client;
  softphoneClient.setRingToneBack?.(false);
  softphoneClient.setConnectTone?.(false);

  softphoneClient.on('onWebrtcNotSupported', () => {
    setSoftphoneStatus('Browser audio is not supported', 'Use the latest Chrome or Firefox desktop browser for the TruckX dialer.', 'error');
  });
  softphoneClient.on('onWebSocketConnected', () => {
    setSoftphoneStatus('Browser phone connected to Plivo', 'Registering the TruckX browser endpoint now.', 'pending');
  });
  softphoneClient.on('onLogin', () => {
    softphoneLoggedIn = true;
    setSoftphoneStatus('Plivo endpoint registered', 'Now joining the TruckX audio bridge. Keep this page open.', 'pending');
    settleSoftphoneLogin();
  });
  softphoneClient.on('onLoginFailed', (cause) => {
    softphoneLoggedIn = false;
    const detail = cause ? ` Plivo message: ${cause}` : '';
    setSoftphoneStatus('Browser phone login failed', `Check PLIVO_BROWSER_USERNAME and PLIVO_BROWSER_PASSWORD in Render.${detail}`, 'error');
    settleSoftphoneLogin(new Error(`Browser phone login failed. Check the Plivo browser endpoint credentials.${detail}`));
  });
  softphoneClient.on('onMediaPermission', (permission) => {
    if (permission === false) {
      setNotice('Microphone permission is required for browser dialing.', 'error');
      setSoftphoneStatus('Microphone permission blocked', 'Allow microphone access in Chrome, then press Start Audio again.', 'error');
    }
  });
  softphoneClient.on('onCalling', () => {
    setSoftphoneStatus('Joining browser audio', 'Chrome is connecting the agent audio bridge.', 'pending');
  });
  softphoneClient.on('onCallConnected', () => {
    softphoneCallActive = true;
    setSoftphoneStatus('Browser audio connected', 'Stay on this page. TruckX will dial customers and connect answered calls here.', 'success');
    setNotice('Browser audio connected. Stay on this page while TruckX dials customers.', 'success');
    window.setTimeout(loadState, 800);
  });
  softphoneClient.on('onMediaConnected', () => {
    softphoneCallActive = true;
    setSoftphoneStatus('Browser audio connected', 'Stay on this page. TruckX will dial customers and connect answered calls here.', 'success');
    setNotice('Browser audio connected. Stay on this page while TruckX dials customers.', 'success');
    window.setTimeout(loadState, 800);
  });
  softphoneClient.on('onCallFailed', (cause) => {
    softphoneCallActive = false;
    const detail = cause ? ` Plivo message: ${cause}` : '';
    setSoftphoneStatus('Browser audio could not connect', `Check microphone permission, endpoint application, and Plivo logs.${detail}`, 'error');
    setNotice(`Browser audio could not connect. Check microphone permission and Plivo endpoint setup.${detail}`, 'error');
  });
  softphoneClient.on('onCallTerminated', () => {
    softphoneCallActive = false;
    setSoftphoneStatus('Browser audio disconnected', 'Press Start Audio again before dialing more customers.', 'error');
    setNotice('Browser audio disconnected.', 'error');
    window.setTimeout(loadState, 800);
  });

  return softphoneClient;
}

async function loginSoftphone(config) {
  const client = initSoftphoneClient();
  if (softphoneLoggedIn || client.isLoggedIn) return;

  setSoftphoneStatus('Registering Plivo endpoint', 'Chrome may ask for microphone permission. Plivo will show Registered after login succeeds.', 'pending');
  await new Promise((resolve, reject) => {
    softphoneLoginWaiter = { resolve, reject };
    client.login(config.username, config.password);
    window.setTimeout(() => {
      settleSoftphoneLogin(new Error('Browser phone login timed out. Try again.'));
    }, 20000);
  });
}

async function connectBrowserSoftphone(campaign) {
  const config = await softphoneConfig();
  if (config.mode !== 'browser') return false;
  if (!config.enabled) {
    throw new Error('Browser softphone is not configured yet. Ask admin to add PLIVO_BROWSER_USERNAME and PLIVO_BROWSER_PASSWORD in Render.');
  }

  await loginSoftphone(config);
  if (softphoneCallActive) return true;

  setNotice('Connecting browser audio. Allow microphone access when Chrome asks.', 'success');
  const started = initSoftphoneClient().call(config.dialTarget, {
    'X-PH-CampaignId': campaign.id,
    'X-PH-SessionId': campaign.currentSessionId || ''
  });
  if (started === false) {
    throw new Error('Browser audio call could not start. Check the Plivo endpoint application and dial target.');
  }
  return true;
}

function disconnectBrowserSoftphone() {
  try {
    softphoneClient?.hangup?.();
  } catch {
    // Stop should continue even if the SDK already ended the call locally.
  }
  softphoneCallActive = false;
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

function currentSession(campaign) {
  if (!campaign?.currentSessionId) return null;
  return (state.sessions || []).find((session) => session.id === campaign.currentSessionId) || null;
}

function needsBrowserAudio(campaign) {
  const session = currentSession(campaign);
  return softphoneMode === 'browser'
    && campaign?.status === 'running'
    && Boolean(campaign.currentSessionId)
    && (!session || !session.agentConnectedAt);
}

function canConnectBrowserAudio(campaign) {
  return softphoneMode === 'browser'
    && campaign?.status === 'running'
    && Boolean(campaign.currentSessionId)
    && !softphoneCallActive;
}

function renderSoftphoneStatus(campaign = selectedCampaign()) {
  if (!elements.audioStatus) return;

  const config = softphoneConfigCache;
  if (!config) {
    elements.audioStatus.hidden = true;
    return;
  }

  let kind = softphoneStatus.kind || 'idle';
  let title = softphoneStatus.title;
  let message = softphoneStatus.message;

  if (config.mode !== 'browser') {
    kind = 'warning';
    title = 'Agent phone mode is active';
    message = 'Render is not in browser audio mode. Set AGENT_CONNECTION_MODE=browser if you do not want the agent phone to ring.';
  } else if (!config.enabled) {
    kind = 'error';
    title = 'Browser audio is not configured';
    message = 'Add PLIVO_BROWSER_USERNAME and PLIVO_BROWSER_PASSWORD in Render, then redeploy.';
  } else if (softphoneCallActive) {
    kind = 'success';
    title = 'Browser audio connected';
    message = 'Stay on this page while TruckX dials customers.';
  } else if (softphoneLoggedIn) {
    kind = 'pending';
    title = 'Plivo endpoint registered';
    message = 'Press Connect Audio if the audio bridge has not joined yet.';
  } else if (campaign?.status === 'running' && campaign.currentSessionId) {
    kind = kind === 'error' ? kind : 'pending';
    title = title || 'Connect browser audio';
    message = message || 'Click Connect Audio and allow microphone access. Customer dialing starts after audio connects.';
  }

  elements.audioStatus.hidden = false;
  elements.audioStatus.className = `audio-status ${kind}`;
  elements.audioStatus.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(message)}</span>
  `;
}

function pendingDispositionCall() {
  const campaign = selectedCampaign();
  if (!campaign) return null;
  return state.calls.find((call) => call.campaignId === campaign.id && call.requiresDisposition);
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
  if (!summary.total) return 'Ask admin to sync or assign a PowerList.';
  if (summary.ready) return 'Ready. Press Start when you are available.';

  const reason = String(summary.topReason || '').toLowerCase();
  if (reason.includes('provider error')) return 'Ask admin to check carrier approval or Plivo logs.';
  if (reason.includes('consent')) return 'Ask admin to update consent in HubSpot.';
  if (reason.includes('attempt')) return 'Ask admin to reset the test lead or update the attempt limit.';
  return 'Ask admin to review the PowerList.';
}

function renderQueueHealth() {
  if (!elements.queueHealth) return;
  const campaign = selectedCampaign();
  const leads = snapshot?.leads || [];

  if (!campaign) {
    elements.queueHealth.hidden = true;
    elements.queueHealth.innerHTML = '';
    return;
  }

  const summary = queueSummary(leads);
  const topReason = summary.topReason
    ? `${summary.topReasonCount} blocked: ${summary.topReason}`
    : 'No blockers';
  const session = currentSession(campaign);
  const agentLineConnecting = campaign.status === 'running' && session && !session.agentConnectedAt;
  const agentLineConnected = campaign.status === 'running' && session?.agentConnectedAt;
  const actionClass = agentLineConnecting || agentLineConnected || summary.ready ? 'ready' : 'blocked';
  const actionTitle = agentLineConnecting
    ? (softphoneMode === 'browser' ? 'Connecting browser audio' : 'Calling agent line')
    : agentLineConnected
      ? (softphoneMode === 'browser' ? 'Browser audio connected' : 'Agent line connected')
      : summary.ready ? 'Queue ready' : 'Queue blocked';
  const actionText = agentLineConnecting
    ? (softphoneMode === 'browser'
        ? 'Keep this tab open and allow microphone access. Customer dialing starts after audio connects.'
        : 'Pick up your phone. Customer dialing starts after you are connected.')
    : agentLineConnected
      ? (softphoneMode === 'browser'
          ? 'Stay on this tab. TruckX will dial customers and connect answered calls here.'
          : 'Stay on this call. TruckX will dial customers and connect answered calls here.')
      : nextQueueAction(summary);

  elements.queueHealth.hidden = false;
  elements.queueHealth.innerHTML = `
    <div class="queue-metrics">
      <div>
        <strong>${escapeHtml(summary.ready)}</strong>
        <span>Ready</span>
      </div>
      <div>
        <strong>${escapeHtml(summary.blocked)}</strong>
        <span>Blocked</span>
      </div>
    </div>
    <div class="queue-action ${actionClass}">
      <strong>${escapeHtml(actionTitle)}</strong>
      <span>${escapeHtml(topReason)}</span>
      <span>${escapeHtml(actionText)}</span>
    </div>
  `;

  if (!['running', 'connected'].includes(campaign.status)) {
    elements.startButton.disabled = summary.ready === 0;
  }
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
  elements.campaignMeta.textContent = `${campaignTarget(current)} | ${current.maxParallelCalls} lines`;
  elements.campaignStatus.outerHTML = statusPill(current.status || 'draft');
  elements.campaignStatus = document.querySelector('.panel-heading .pill');
  const connectAudio = needsBrowserAudio(current);
  const canReconnectAudio = canConnectBrowserAudio(current);
  elements.startButton.textContent = connectAudio || canReconnectAudio
    ? 'Connect Audio'
    : softphoneMode === 'browser' ? 'Start Audio' : 'Start';
  elements.startButton.disabled = connectAudio || canReconnectAudio ? false : ['running', 'connected'].includes(current.status);
  elements.stopButton.disabled = !['running', 'connected', 'paused'].includes(current.status);
  renderSoftphoneStatus(current);
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
    activeDispositionCallId = '';
    return;
  }

  const isNewDisposition = activeDispositionCallId !== call.id;
  activeDispositionCallId = call.id;
  elements.dispositionPanel.hidden = false;
  elements.dispositionLead.textContent = `${call.leadName} | ${call.leadPhone} | ${call.outcome || 'completed'}`;
  elements.dispositionForm.dataset.callId = call.id;
  if (isNewDisposition) elements.dispositionStatus.focus();
}

function renderCalls() {
  const campaign = selectedCampaign();
  const calls = state.calls.filter((call) => !campaign || call.campaignId === campaign.id);
  const activeCalls = calls.filter((call) => ACTIVE_STATUSES.has(call.status));
  const abandonedCalls = calls.filter((call) => call.outcome === 'abandoned').slice(0, 8);
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

  elements.abandonedCalls.innerHTML = abandonedCalls.length
    ? abandonedCalls.map((call) => `
      <div class="call-card">
        <strong>${escapeHtml(call.leadName)}</strong>
        <span>${escapeHtml(call.leadPhone)} | ${escapeHtml(call.abandonReason || 'agent busy')}</span>
        ${statusPill('abandoned')}
      </div>
    `).join('')
    : '<div class="empty">No abandoned calls</div>';
}

function render() {
  showAgent();
  renderHeader();
  renderStats();
  renderCampaigns();
  renderQueueHealth();
  renderLeads();
  renderDisposition();
  renderCalls();
}

async function loadState() {
  state = await api('/api/state');
  await softphoneConfig().catch(() => {});
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
  let startedCampaign = null;
  try {
    const wasWaitingForBrowserAudio = needsBrowserAudio(campaign);
    const wasRunningWithoutLocalAudio = canConnectBrowserAudio(campaign);
    const campaignToConnect = wasWaitingForBrowserAudio
      || wasRunningWithoutLocalAudio
      ? campaign
      : await api(`/api/campaigns/${campaign.id}/start`, { method: 'POST' });
    startedCampaign = wasWaitingForBrowserAudio || wasRunningWithoutLocalAudio ? null : campaignToConnect;
    const browserConnecting = await connectBrowserSoftphone(campaignToConnect);
    if (!browserConnecting) {
      setNotice('Dialer started.', 'success');
    }
    await loadState();
  } catch (error) {
    if (startedCampaign?.id) {
      await api(`/api/campaigns/${startedCampaign.id}/stop`, { method: 'POST' }).catch(() => {});
    }
    setNotice(error.message, 'error');
    await loadState().catch(() => {});
  }
});

elements.stopButton.addEventListener('click', async () => {
  const campaign = selectedCampaign();
  if (!campaign) return;
  try {
    await api(`/api/campaigns/${campaign.id}/stop`, { method: 'POST' });
    disconnectBrowserSoftphone();
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
    setNotice('Lead status saved. TruckX will resume dialing when the queue is ready.', 'success');
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
