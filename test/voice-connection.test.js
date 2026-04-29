import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldReuseVoiceConnection, formatVoiceJoinError } from '../src/voice-connection.js';

test('shouldReuseVoiceConnection reuses ready connection already in target channel', () => {
  const existing = {
    joinConfig: { guildId: 'guild-1', channelId: 'voice-1' },
    state: { status: 'ready' },
  };

  assert.equal(shouldReuseVoiceConnection(existing, 'guild-1', 'voice-1', 'ready'), true);
});

test('shouldReuseVoiceConnection does not reuse stale or wrong-channel connection', () => {
  assert.equal(shouldReuseVoiceConnection(null, 'guild-1', 'voice-1', 'ready'), false);
  assert.equal(shouldReuseVoiceConnection({ joinConfig: { guildId: 'guild-1', channelId: 'voice-2' }, state: { status: 'ready' } }, 'guild-1', 'voice-1', 'ready'), false);
  assert.equal(shouldReuseVoiceConnection({ joinConfig: { guildId: 'guild-1', channelId: 'voice-1' }, state: { status: 'connecting' } }, 'guild-1', 'voice-1', 'ready'), false);
});

test('formatVoiceJoinError turns Discord voice AbortError into actionable message', () => {
  const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

  assert.match(formatVoiceJoinError(err, 'voice-chat'), /Timed out joining \*\*voice-chat\*\*/);
  assert.doesNotMatch(formatVoiceJoinError(err, 'voice-chat'), /operation was aborted/i);
});
