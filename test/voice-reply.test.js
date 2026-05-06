import test from 'node:test';
import assert from 'node:assert/strict';

import { formatDiscordVoiceReply, shouldSynthesizeForListener } from '../src/voice-reply.js';

test('formatDiscordVoiceReply keeps Discord replies under 2000 chars', () => {
  const reply = 'x'.repeat(2500);
  const formatted = formatDiscordVoiceReply(reply);

  assert.ok(formatted.length <= 2000);
  assert.ok(formatted.startsWith('🔊 **Hermes:** '));
  assert.ok(formatted.endsWith('…'));
});

test('shouldSynthesizeForListener skips expensive TTS when no allowed listener remains', () => {
  assert.equal(shouldSynthesizeForListener({ connected: true, hasListener: true }), true);
  assert.equal(shouldSynthesizeForListener({ connected: false, hasListener: true }), false);
  assert.equal(shouldSynthesizeForListener({ connected: true, hasListener: false }), false);
});
