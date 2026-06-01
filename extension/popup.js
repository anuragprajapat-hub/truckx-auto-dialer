const setupView = document.querySelector('#setupView');
const agentView = document.querySelector('#agentView');
const connectionState = document.querySelector('#connectionState');
const apiBaseUrlInput = document.querySelector('#apiBaseUrl');
const inviteTokenInput = document.querySelector('#inviteToken');
const activateButton = document.querySelector('#activateButton');
const openAppButton = document.querySelector('#openAppButton');
const disconnectButton = document.querySelector('#disconnectButton');
const setupMessage = document.querySelector('#setupMessage');
const agentName = document.querySelector('#agentName');
const agentEmail = document.querySelector('#agentEmail');

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(values) {
  return chrome.storage.local.set(values);
}

function storageRemove(keys) {
  return chrome.storage.local.remove(keys);
}

async function api(path, options = {}) {
  const { apiBaseUrl, authToken } = await storageGet(['apiBaseUrl', 'authToken']);
  const response = await fetch(`${cleanBaseUrl(apiBaseUrl || apiBaseUrlInput.value)}${path}`, {
    ...options,
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
}

function showAgent(agent) {
  setupView.hidden = true;
  agentView.hidden = false;
  connectionState.textContent = 'Connected';
  agentName.textContent = agent.name || 'Agent';
  agentEmail.textContent = agent.email || '';
}

function showSetup(message = '') {
  setupView.hidden = false;
  agentView.hidden = true;
  connectionState.textContent = 'Not connected';
  setupMessage.textContent = message;
}

async function restore() {
  const saved = await storageGet(['apiBaseUrl', 'authToken', 'agent']);
  if (saved.apiBaseUrl) apiBaseUrlInput.value = saved.apiBaseUrl;
  if (!saved.authToken) {
    showSetup();
    return;
  }

  try {
    const result = await api('/api/extension/me');
    await storageSet({ agent: result.agent });
    showAgent(result.agent);
  } catch {
    await storageRemove(['authToken', 'agent']);
    showSetup('Session expired. Paste a setup token again.');
  }
}

activateButton.addEventListener('click', async () => {
  const apiBaseUrl = cleanBaseUrl(apiBaseUrlInput.value);
  const inviteToken = String(inviteTokenInput.value || '').trim();
  if (!apiBaseUrl || !inviteToken) {
    showSetup('App URL and setup token are required.');
    return;
  }

  activateButton.disabled = true;
  setupMessage.textContent = 'Activating...';
  try {
    await storageSet({ apiBaseUrl });
    const result = await api(`/api/invites/${encodeURIComponent(inviteToken)}/accept`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    await storageSet({
      apiBaseUrl,
      authToken: result.token,
      agent: result.agent
    });
    showAgent(result.agent);
  } catch (error) {
    showSetup(error.message);
  } finally {
    activateButton.disabled = false;
  }
});

openAppButton.addEventListener('click', async () => {
  const { apiBaseUrl } = await storageGet(['apiBaseUrl']);
  chrome.tabs.create({ url: cleanBaseUrl(apiBaseUrl || apiBaseUrlInput.value) });
});

disconnectButton.addEventListener('click', async () => {
  await storageRemove(['authToken', 'agent']);
  showSetup('Disconnected.');
});

restore();
