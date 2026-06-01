import { config } from '../config.js';
import { createMockProvider } from './mockProvider.js';
import { createPlivoProvider } from './plivoProvider.js';
import { createTwilioProvider } from './twilioProvider.js';

export function createVoiceProvider() {
  if (config.voiceProvider === 'twilio') return createTwilioProvider();
  if (config.voiceProvider === 'plivo') return createPlivoProvider();
  return createMockProvider();
}
