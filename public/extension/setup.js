const params = new URLSearchParams(window.location.search);
const inviteToken = params.get('invite') || '';

const statusText = document.querySelector('#statusText');
const inviteDetails = document.querySelector('#inviteDetails');
const agentName = document.querySelector('#agentName');
const agentEmail = document.querySelector('#agentEmail');
const ownerId = document.querySelector('#ownerId');
const copyInviteButton = document.querySelector('#copyInviteButton');
const copyAppUrlButton = document.querySelector('#copyAppUrlButton');
const setupSteps = document.querySelector('#setupSteps');
const setupValues = document.querySelector('#setupValues');
const appUrl = document.querySelector('#appUrl');
const setupToken = document.querySelector('#setupToken');

if (inviteToken) {
  window.location.replace(`/agent/?token=${encodeURIComponent(inviteToken)}`);
}

async function lookupInvite() {
  if (!inviteToken) {
    statusText.textContent = 'This setup link is missing an invite token.';
    return;
  }

  const response = await fetch(`/api/invites/${encodeURIComponent(inviteToken)}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    statusText.textContent = body.error || 'This invite could not be found.';
    return;
  }

  const statusMessages = {
    pending: 'Your invitation is ready.',
    accepted: 'This agent is already activated. You can use the same web login link to reconnect.',
    expired: 'This invitation has expired. Ask your admin for a new invite.'
  };
  statusText.textContent = statusMessages[body.invite.status] || `This invitation is ${body.invite.status}.`;
  agentName.textContent = body.agent.name;
  agentEmail.textContent = body.agent.email;
  ownerId.textContent = body.agent.hubspotOwnerId || 'Not linked yet';
  inviteDetails.hidden = false;
  setupSteps.hidden = false;
  setupValues.hidden = false;
  appUrl.value = window.location.origin;
  setupToken.value = inviteToken;
  copyInviteButton.hidden = false;
  copyAppUrlButton.hidden = false;
}

copyInviteButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(inviteToken);
  copyInviteButton.textContent = 'Login token copied';
});

copyAppUrlButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(window.location.origin);
  copyAppUrlButton.textContent = 'App URL copied';
});

if (!inviteToken) {
  lookupInvite().catch((error) => {
    statusText.textContent = error.message;
  });
}
