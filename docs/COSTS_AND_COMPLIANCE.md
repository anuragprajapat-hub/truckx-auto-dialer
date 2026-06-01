# Truckx Auto Dialer Costs And Compliance Notes

## Expected Costs

The app code can be owned by you, but phone infrastructure is not free.

- Voice calls: usually about `$0.005` to `$0.015` per minute for US outbound, depending on carrier and volume.
- Phone numbers: often around `$0.50` to `$1.50` per number per month.
- Hosting: about `$20` to `$200` per month for an early production system.
- DNC access/compliance tools: depends on calling footprint and whether you use official registry access, scrub vendors, or internal controls.

## Compliance Features To Implement Before Production

- DNC suppression list.
- Internal opt-out list.
- Consent field from HubSpot.
- US local-time call window.
- State-specific restrictions if applicable.
- Max attempt limits.
- Retry spacing.
- Caller ID number controls.
- Call recording disclosure handling where required.
- Audit log for every skipped/dialed lead.

## Recommended First Production Rule Set

- Only call `+1` numbers.
- Only call contacts with a positive consent flag or existing business relationship policy approved by counsel.
- Block before 9:00 AM and after 6:00 PM recipient local time.
- Max 3 attempts per lead per campaign.
- Never call DNC/opted-out contacts.
- Write every outcome back to HubSpot.

This is not legal advice. Have counsel review TCPA, TSR, state mini-TCPA laws, DNC, consent, and recording rules before live US outbound campaigns.
