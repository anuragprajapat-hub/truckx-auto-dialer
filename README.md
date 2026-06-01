# Truckx Auto Dialer

This is a standalone autodialer prototype for a sales team calling US numbers. It is separate from the sales dashboard and starts in mock mode so the campaign flow can be tested without spending money on calls.

## What It Does Now

- Creates owner-based campaigns.
- Pulls sample leads by owner in mock mode.
- Runs a multi-line dialer simulation.
- Detects mock outcomes: live answer, voicemail, no answer, busy, failed.
- Updates lead status in the local store.
- Shows live campaign, queue, active calls, and call log in the browser.
- Includes starter adapters for Twilio and Plivo so real calling can be wired next.
- Supports caller ID number pools through `CALLER_ID_NUMBERS`.
- Includes setup checks for missing HubSpot/carrier credentials.

## Run Locally

```powershell
node server.js
```

Then open:

```text
http://localhost:4242
```

## Configure Real Accounts

Copy `.env.example` to `.env`, then set:

```text
LEAD_SOURCE=hubspot
HUBSPOT_PRIVATE_APP_TOKEN=...
VOICE_PROVIDER=twilio
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
CALLER_ID_NUMBER=+1...
CALLER_ID_NUMBERS=+1...,+1...
DEFAULT_AGENT_PHONE=+1...
PUBLIC_BASE_URL=https://your-public-domain.example
```

For local real-call testing, the voice provider must reach your webhook URLs. That means `PUBLIC_BASE_URL` needs a public HTTPS URL, not plain localhost.

Credential instructions are in [docs/GET_CREDENTIALS.md](docs/GET_CREDENTIALS.md).

## HubSpot Setup

Create a HubSpot private app with scopes for reading contacts/owners and writing contacts/calls. The app expects these contact properties if you want full automation:

```text
dialer_consent
do_not_call
dialer_attempts
last_call_outcome
us_time_zone
```

Use the dashboard setup panel or these endpoints:

```text
GET  /api/setup
POST /api/hubspot/owners/sync
POST /api/campaigns/:id/sync-hubspot
```

## Important

This is a technical MVP, not legal advice. A US outbound dialer needs consent/DNC controls, local time-window enforcement, opt-out handling, retry limits, call recording notices where required, and clear auditing before production use.
