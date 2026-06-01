const params = new URLSearchParams(window.location.search);
const inviteToken = params.get('invite') || '';

const statusText = document.querySelector('#statusText');
const inviteDetails = document.querySelector('#inviteDetails');
const agentName = document.querySelector('#agentName');
const agentEmail = document.querySelector('#agentEmail');
const ownerId = document.querySelector('#ownerId');
const copyInviteButton = document.querySelector('#copyInviteButton');

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

  statusText.textContent = body.invite.status === 'pending'
    ? 'Your invitation is ready.'
    : `This invitation is ${body.invite.status}.`;
  agentName.textContent = body.agent.name;
  agentEmail.textContent = body.agent.email;
  ownerId.textContent = body.agent.hubspotOwnerId || 'Not linked yet';
  inviteDetails.hidden = false;
  copyInviteButton.hidden = false;
}

copyInviteButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(inviteToken);
  copyInviteButton.textContent = 'Setup token copied';
});

lookupInvite().catch((error) => {
  statusText.textContent = error.message;
});
