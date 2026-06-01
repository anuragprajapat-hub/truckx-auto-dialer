# Truckx Auto Dialer

This is a standalone autodialer prototype for a sales team calling US numbers. It is separate from the sales dashboard and starts in mock mode so the campaign flow can be tested without spending money on calls.

## What It Does Now

- Creates owner-based campaigns.
- Pulls contacts by HubSpot owner and pages through up to `HUBSPOT_SYNC_LIMIT` contacts.
- Filters campaigns by HubSpot `TIME ZONE` values: `EST`, `CST`, `MST`, `PST`, or all zones.
- Runs a configurable multi-line predictive dialer simulation.
- Detects mock outcomes: live answer, voicemail, no answer, busy, failed.
- Pauses a campaign after a live answer and shows an after-call lead status box.
- Updates lead status in the local store.
- Shows live campaign, queue, active calls, call log, and agent reports in the browser.
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
APP_USERNAME=admin
APP_PASSWORD=choose-a-strong-password
```

For local real-call testing, the voice provider must reach your webhook URLs. That means `PUBLIC_BASE_URL` needs a public HTTPS URL, not plain localhost.

Set `APP_PASSWORD` before syncing real HubSpot contacts into a public deployment. Without it, the dashboard and API are public.

For separate agent logins, set `APP_USERS` instead of only one global login:

```text
APP_USERS=admin:strong-password:admin,sooraj:agent-password:agent:840722698
```

Format:

```text
username:password:role:hubspot_owner_id
```

Admins can see all owners. Agents only see campaigns/leads for their HubSpot owner ID.

Credential instructions are in [docs/GET_CREDENTIALS.md](docs/GET_CREDENTIALS.md).

## HubSpot Setup

Create a HubSpot private app with scopes for reading contacts/owners and writing contacts/calls. The app expects these contact properties if you want full automation:

```text
dialer_consent
do_not_call
time_zone
last_call_outcome
dialer_attempts
```

If you already have existing properties, link them by internal name in Render:

```text
HUBSPOT_PROP_CONSENT=dialer_consent
HUBSPOT_PROP_DNC=do_not_call
HUBSPOT_PROP_ATTEMPTS=dialer_attempts
HUBSPOT_PROP_LAST_OUTCOME=last_call_outcome
HUBSPOT_PROP_TIME_ZONE=time_zone
HUBSPOT_PROP_LEAD_STATUS=hs_lead_status
```

Your HubSpot display label can be `TIME ZONE`; the app needs the internal name, which you showed as `time_zone`. Values can be `EST`, `CST`, `MST`, or `PST`.

Campaign examples:

```text
SOORAJ PST -> owner Sooraj Kumar, zone PST
SOORAJ EST -> owner Sooraj Kumar, zone EST
SOORAJ ALL -> owner Sooraj Kumar, zone All zones
```

The app does not require you to manually edit every contact's timezone or lead status if those fields already exist in HubSpot. It reads the existing internal property values when you click **Sync**.

Use the dashboard setup panel or these endpoints:

```text
GET  /api/setup
POST /api/hubspot/owners/sync
POST /api/campaigns/:id/sync-hubspot
GET  /api/reports/agents
```

## Important

This is a technical MVP, not legal advice. A US outbound dialer needs consent/DNC controls, local time-window enforcement, opt-out handling, retry limits, call recording notices where required, and clear auditing before production use.
