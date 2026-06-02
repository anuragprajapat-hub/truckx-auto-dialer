# TruckX Chrome Extension

This is the starter Chrome extension for TruckX agents.

## Local Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `extension` folder.
5. Open the extension popup.
6. Paste the setup token from the TruckX invite link.

During local testing, each agent needs to load the unpacked extension once on their own Chrome profile. After the extension is packaged or published, agents install it normally instead of choosing the repo folder.

## Current Features

- Accepts a TruckX invitation token.
- Stores the agent API token in Chrome local storage.
- Checks the agent session against the TruckX backend.
- Opens the agent-only TruckX web dialer at `/agent/`.
- Loads a placeholder content script on HubSpot pages.

## Next Features

- Detect HubSpot contact records.
- Add an embedded dial button on HubSpot contact pages.
- Show active PowerLists assigned to the agent.
- Submit after-call dispositions from the popup.
- Package for Chrome Web Store.
