import { config } from './config.js';

export async function sendAgentInviteEmail({ agent, invite }) {
  if (!config.email.resendApiKey) {
    return { sent: false, skipped: true, reason: 'RESEND_API_KEY is not configured' };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.email.resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: config.email.from,
      to: [agent.email],
      subject: 'Your TruckX Auto Dialer invitation',
      text: [
        `Hi ${agent.name || 'there'},`,
        '',
        'You have been invited to TruckX Auto Dialer.',
        `Open this link in Chrome to access your agent dialer: ${invite.inviteUrl}`,
        '',
        'If you were not expecting this invitation, ignore this email.'
      ].join('\n')
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || `Invite email failed with ${response.status}`);
  }

  return { sent: true, provider: 'resend', id: body.id || '' };
}
