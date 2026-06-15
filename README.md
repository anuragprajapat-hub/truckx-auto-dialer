# TruckX Auto Dialer

This is a standalone autodialer prototype for a sales team calling US numbers. It is separate from the sales dashboard and starts in mock mode so the campaign flow can be tested without spending money on calls.

## What It Does Now

- Creates owner-based campaigns.
- Pulls all contacts assigned to a HubSpot owner using paged API requests.
- Filters campaigns by HubSpot `TIME ZONE` values: `EST`, `CST`, `MST`, `PST`, or all zones.
- Runs a configurable multi-line predictive dialer simulation.
- Detects mock outcomes: live answer, voicemail, no answer, busy, failed.
- Pauses a campaign after a live answer and shows an after-call lead status box.
- Updates lead status in the local store.
- Shows live campaign, queue, active calls, call log, and agent reports in the browser.
- Adds an admin-style portal with PowerLists, Reports, Call History, Agents, Live, and Setup sections.
- Adds an agent-only dialer portal where agents can use assigned PowerLists, filter by HubSpot lead status, start/stop dialing, see connected customer details, hang up a customer leg, and save after-call lead status.
- Lets agents manually dial or redial a US number through their connected browser audio session.
- Adds a connected-call keypad for sending DTMF digits to automated phone menus.
- Supports browser softphone mode so the agent can click Start, connect audio in Chrome, and stay connected while TruckX dials customers.
- Adds TruckX logo assets, favicon, agent web login branding, and a startup splash screen.
- Lets admins invite agents by name/email and HubSpot owner.
- Lets agents log in directly through a browser link; the Chrome extension is optional/future HubSpot page integration.
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

### Browser Agent Mode

Use browser mode when you do not want the agent's Zoom/mobile phone to ring. In this mode the agent's Chrome tab becomes the phone:

```text
VOICE_PROVIDER=plivo
AGENT_CONNECTION_MODE=browser
PLIVO_AUTH_ID=...
PLIVO_AUTH_TOKEN=...
PLIVO_BROWSER_USERNAME=...
PLIVO_BROWSER_PASSWORD=...
PLIVO_BROWSER_DIAL_TARGET=truckx-agent@phone.plivo.com
```

In Plivo, create an XML Application for the browser endpoint:

```text
Answer URL: https://truckx-auto-dialer.onrender.com/webhooks/plivo/browser-agent-session
Answer Method: POST
Hangup URL: https://truckx-auto-dialer.onrender.com/webhooks/plivo/status
Hangup Method: POST
```

Then create a Plivo Endpoint, attach it to that application, and put the endpoint username/password in Render as `PLIVO_BROWSER_USERNAME` and `PLIVO_BROWSER_PASSWORD`. After Render redeploys, the agent clicks Start, allows microphone access, and TruckX begins dialing customers only after browser audio connects.

For multiple live agents, create one Plivo Endpoint per agent. In the TruckX **Agents** form, save that endpoint's username/password and the agent's verified caller ID with the matching HubSpot owner. The global `PLIVO_BROWSER_USERNAME`, `PLIVO_BROWSER_PASSWORD`, and `CALLER_ID_NUMBER` remain fallbacks for older test accounts only.

The Plivo Endpoint controls the agent's browser audio connection; it does not determine the caller ID shown to customers. TruckX loads the account's Plivo **Verified Caller IDs** and requires a verified number when creating an agent or PowerList. The selected PowerList caller ID is sent as Plivo's outbound `from` number. One shared Endpoint is suitable for one agent testing at a time, but simultaneous browser agents need separate Endpoints.

After verifying a new caller ID in Plivo, use **Refresh Plivo numbers** in the admin portal. TruckX also refreshes automatically within 30 seconds and retries Plivo directly before rejecting a newly verified number.

HubSpot contact synchronization retrieves every page for the selected owner using object-ID keyset pagination, avoiding CRM Search cursor windows for owners with very large contact lists. If optional custom properties such as `last_call_outcome` or `dialer_attempts` are not installed in the HubSpot portal, TruckX skips only those fields and still imports the owner's contacts.

When TruckX starts, it automatically performs a one-time recovery sync for existing PowerLists whose owner currently has no imported leads. PowerLists that already have leads are not reimported by this startup recovery.

The admin portal loads lead readiness per PowerList in 100-lead pages. Queue totals are calculated server-side, so large owner lists remain fully countable and accessible without transferring or rendering every contact on each dashboard refresh.

When the admin invites an agent and leaves the endpoint username/password blank, TruckX automatically creates a unique Plivo Endpoint and attaches it to the same Plivo application as the configured shared browser Endpoint. Set `PLIVO_APPLICATION_ID` only if TruckX cannot infer that application from `PLIVO_BROWSER_USERNAME`. Deleting an agent also removes an automatically managed Endpoint from Plivo.

In browser mode, the PowerList `Lines` value controls predictive customer dialing and can be edited after creation. If `Lines` is `3`, TruckX can ring up to 3 customer numbers while the agent is idle in the browser audio session. As soon as one customer answers, TruckX cancels the remaining ringing calls and pauses new dialing until that conversation ends and the agent saves the after-call outcome. If another customer answers after the agent is already connected, TruckX hangs up that extra customer leg and records it as `abandoned` so it is visible in the agent and admin Live views. Voicemail and no-answer results do not stop the PowerList; the next eligible contacts are dialed automatically.

Manual dial and redial require a running PowerList with the agent audio session connected. The connected-call keypad sends DTMF through Plivo for phone menus such as "press 1 for sales."

By default, a PowerList can dial every otherwise safe HubSpot lead status. The agent lead-status filter can narrow the queue to a value such as `VOICEMAIL` or `FOLLOWUP`. Global DNC, invalid-number, provider-error, time-zone, and maximum-attempt checks still apply. To enforce a deployment-wide allowlist, set both `STRICT_CALLABLE_LEAD_STATUSES=true` and `CALLABLE_LEAD_STATUSES`.

For separate agent logins, set `APP_USERS` instead of only one global login:

```text
APP_USERS=admin:strong-password:admin,sooraj:agent-password:agent:840722698
```

Format:

```text
username:password:role:hubspot_owner_id
```

Admins can see all owners. Agents only see campaigns/leads for their HubSpot owner ID.

## Agent Web Invitations

Admins can invite an agent from the **Agents** page:

1. Sync HubSpot owners.
2. Open **Agents**.
3. Enter the agent name and email.
4. Select the matching HubSpot owner.
5. Enter the agent's Plivo-verified caller ID.
6. For simultaneous agents, enter that agent's unique Plivo Endpoint username and password.
7. Click **Send Invitation**.

If email sending is not configured, TruckX creates a web login link and shows **Copy web login link** in the Agents table. If email sending is configured, the app emails the login link automatically.

Optional email sending uses Resend:

```text
RESEND_API_KEY=...
INVITE_FROM_EMAIL=TruckX Auto Dialer <dialer@truckx.com>
```

For real invites, verify the sending domain in Resend first. A personal Gmail/Yahoo address cannot be used as the `from` address unless that exact domain is verified in Resend; for TruckX, use a sender on the company domain such as `dialer@truckx.com` or `no-reply@truckx.com` after DNS verification.

For real-agent testing:

1. Copy the web login link from the Agents table.
2. Send it to the agent.
3. The agent opens it in Chrome.
4. The agent allows microphone permission.
5. The agent selects an assigned PowerList and clicks **Start Audio**.

The old `/extension/?invite=...` setup links now redirect into `/agent/?token=...`, so agents do not need to install the unpacked Chrome extension for testing. The starter extension still lives in `extension/` for future HubSpot page integration.

Deleting an agent removes their TruckX access and pending login links but keeps historical calls and reports. The same email can be invited again later.

## Logo Options

Open this page after deployment to compare logo directions:

```text
https://truckx-auto-dialer.onrender.com/logo-options.html
```

The current web default is **C**. The optional starter extension uses the compact **B** mark.

Credential instructions are in [docs/GET_CREDENTIALS.md](docs/GET_CREDENTIALS.md).

## HubSpot Setup

Create a HubSpot private app with scopes for reading contacts/owners and writing contacts/calls. Also add the HubSpot contact property/schema read scope if it is available in your portal; the after-call popup uses it to load your real HubSpot Lead Status dropdown options instead of a hardcoded list. The app uses these optional contact properties when they exist:

```text
dialer_consent
do_not_call
time_zone
last_call_outcome
dialer_attempts
```

Missing optional properties are skipped. Lead Status and HubSpot call activities still update.

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
