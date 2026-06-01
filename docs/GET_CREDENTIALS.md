# Truckx Auto Dialer Credential Guide

This file lists the credentials needed to turn mock mode into live calling.

## 1. HubSpot Private App Token

Needed for:

- Pulling contacts by HubSpot owner.
- Syncing HubSpot owners.
- Updating lead status, attempts, and last call outcome.
- Creating HubSpot call activities.

Where to get it:

1. In HubSpot, go to **Development**.
2. Open **Legacy apps**.
3. Click **Create legacy app**, then choose **Private**.
4. Add the required CRM scopes.
5. After creating the app, open the **Auth** tab.
6. Click **Show token**, then copy the access token.

Set it in `.env`:

```text
LEAD_SOURCE=hubspot
HUBSPOT_PRIVATE_APP_TOKEN=pat-...
```

Also set app login protection before using real leads:

```text
APP_USERNAME=admin
APP_PASSWORD=choose-a-strong-password
```

For multiple logins, use this instead:

```text
APP_USERS=admin:strong-password:admin,sooraj:agent-password:agent:840722698
```

Each login is:

```text
username:password:role:hubspot_owner_id
```

Use `admin` for an admin user. Use `agent` plus the HubSpot owner ID for an agent user. You can get the owner ID after clicking **Owners** in Truckx or from HubSpot owner settings/API.

The newer invite flow means agents do not need manually created passwords. Keep an admin login for the portal, then invite agents from **Agents**. Invited agents activate through the Chrome extension and receive an extension token.

Optional email invitation delivery:

```text
RESEND_API_KEY=...
INVITE_FROM_EMAIL=Truckx Auto Dialer <dialer@yourdomain.com>
```

Without these, the admin can copy the invite link from the Agents table and send it manually.

Recommended scopes:

```text
crm.objects.contacts.read
crm.objects.contacts.write
crm.objects.owners.read
```

If HubSpot shows these, you can add them, but many HubSpot portals do not show separate calls scopes:

```text
crm.objects.calls.read
crm.objects.calls.write
```

That is okay. HubSpot's current calls API documentation lists contact scopes for logging calls against contact records, so `crm.objects.contacts.write` is the important write permission for Truckx call logging.

## HubSpot Property Mapping

If you already have HubSpot properties, use their exact **internal names** instead of creating duplicates. Configure them in Render or `.env`:

```text
HUBSPOT_PROP_CONSENT=dialer_consent
HUBSPOT_PROP_DNC=do_not_call
HUBSPOT_PROP_ATTEMPTS=dialer_attempts
HUBSPOT_PROP_LAST_OUTCOME=last_call_outcome
HUBSPOT_PROP_TIME_ZONE=time_zone
HUBSPOT_PROP_LEAD_STATUS=hs_lead_status
```

For the properties you mentioned, Truckx now defaults to these internal names:

```text
last_call_outcome
time_zone
```

If the display label is similar but the internal name is different, put the real internal name into `HUBSPOT_PROP_LAST_OUTCOME` or `HUBSPOT_PROP_TIME_ZONE`.

For your current HubSpot setup, use:

```text
HUBSPOT_PROP_TIME_ZONE=time_zone
HUBSPOT_PROP_CONSENT=dialer_consent
HUBSPOT_PROP_DNC=do_not_call
HUBSPOT_PROP_LAST_OUTCOME=last_call_outcome
```

`TIME ZONE` values should be:

```text
EST
CST
MST
PST
```

Truckx converts those to the correct US local call windows internally, but the dashboard shows the short labels.

By default Truckx only dials leads with these statuses:

```text
CALLABLE_LEAD_STATUSES=new,retry,no_answer
```

Statuses like `Won`, `REJECTED`, `VOICEMAIL`, and blank statuses are blocked unless you intentionally add them to `CALLABLE_LEAD_STATUSES`.

If you want Truckx to sync more than 100 contacts under one owner, set:

```text
HUBSPOT_SYNC_LIMIT=1000
```

The app pages through HubSpot contacts up to that limit.

## 2. Voice Provider

Choose one provider first. I recommend starting with **Plivo** if you want lower carrier cost, or **Twilio** if you prefer broader docs and tooling.

### Twilio

Needed values:

```text
VOICE_PROVIDER=twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
CALLER_ID_NUMBERS=+1...,+1...
```

Where to get them:

- Account SID and Auth Token are in the Twilio Console.
- Buy voice-capable US numbers in Twilio Console under phone numbers/numbers and senders.

### Plivo

Needed values:

```text
VOICE_PROVIDER=plivo
PLIVO_AUTH_ID=...
PLIVO_AUTH_TOKEN=...
CALLER_ID_NUMBERS=+1...,+1...
```

Where to get them:

- Auth ID and Auth Token are on the Plivo Console overview page.
- Rent voice-capable US numbers in **Phone Numbers > Buy Numbers**.

## 3. Public HTTPS Webhook URL

Real calls need carrier callbacks. Localhost will not work for live calls.

For local testing, use ngrok:

```text
ngrok http 4242
```

Then set:

```text
PUBLIC_BASE_URL=https://your-ngrok-domain.ngrok.app
```

For production, use your hosted app URL instead.

## HubSpot Webhook Settings

HubSpot webhooks are optional for the first working version. Truckx can pull contacts from HubSpot when you click **Sync**.

If you want to enable HubSpot webhooks later, use this target URL:

```text
https://your-public-domain/webhooks/hubspot/contact
```

Recommended first subscriptions:

```text
contact.propertyChange
```

Useful properties to subscribe to:

```text
hubspot_owner_id
phone
mobilephone
hs_lead_status
dialer_consent
do_not_call
time_zone
```

Set event throttling low at first, for example `10`, then increase it after testing.

## 4. Optional Voicemail Drop Audio

If you want voicemail drop:

```text
VOICEMAIL_AUDIO_URL=https://your-domain.com/voicemail.mp3
```

Use a short hosted MP3/WAV file.

## 5. Do Not Send Publicly

Treat these like passwords:

```text
HUBSPOT_PRIVATE_APP_TOKEN
TWILIO_AUTH_TOKEN
PLIVO_AUTH_TOKEN
```

Share them only in a secure channel or enter them directly into `.env` on the machine that runs the app.
