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
HUBSPOT_PROP_TIME_ZONE=us_time_zone
HUBSPOT_PROP_LEAD_STATUS=hs_lead_status
```

For the properties you mentioned, if their internal names are exactly below, they are already linked by default:

```text
last_call_outcome
us_time_zone
```

If the display label is similar but the internal name is different, put the real internal name into `HUBSPOT_PROP_LAST_OUTCOME` or `HUBSPOT_PROP_TIME_ZONE`.

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
us_time_zone
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
