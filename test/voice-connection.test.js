import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldDestroyVoiceConnection,
  shouldRetryVoiceJoin,
  shouldReuseVoiceConnection,
  shouldReplaceStaleVoiceConnection,
  shouldKeepPendingVoiceConnection,
  formatVoiceJoinError,
  voiceJoinRetryDelayMs,
} from '../src/voice-connection.js';

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

test('shouldReplaceStaleVoiceConnection replaces same-channel non-ready handshakes', () => {
  assert.equal(shouldReplaceStaleVoiceConnection({ joinConfig: { guildId: 'guild-1', channelId: 'voice-1' }, state: { status: 'connecting' } }, 'guild-1', 'voice-1', 'ready'), true);
  assert.equal(shouldReplaceStaleVoiceConnection({ joinConfig: { guildId: 'guild-1', channelId: 'voice-1' }, state: { status: 'signalling' } }, 'guild-1', 'voice-1', 'ready'), true);
  assert.equal(shouldReplaceStaleVoiceConnection({ joinConfig: { guildId: 'guild-1', channelId: 'voice-1' }, state: { status: 'ready' } }, 'guild-1', 'voice-1', 'ready'), false);
  assert.equal(shouldReplaceStaleVoiceConnection({ joinConfig: { guildId: 'guild-1', channelId: 'voice-2' }, state: { status: 'connecting' } }, 'guild-1', 'voice-1', 'ready'), false);
  assert.equal(shouldReplaceStaleVoiceConnection({ joinConfig: { guildId: 'guild-1', channelId: 'voice-1' }, state: { status: 'destroyed' } }, 'guild-1', 'voice-1', 'ready'), false);
});

test('formatVoiceJoinError turns Discord voice AbortError into actionable message', () => {
  const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

  assert.match(formatVoiceJoinError(err, 'voice-chat', 3), /Could not join \*\*voice-chat\*\* after 3 attempt/);
  assert.doesNotMatch(formatVoiceJoinError(err, 'voice-chat', 3), /operation was aborted/i);
});

test('shouldRetryVoiceJoin retries abort timeouts before surfacing failure', () => {
  const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

  assert.equal(shouldRetryVoiceJoin(err, 1, 3), true);
  assert.equal(shouldRetryVoiceJoin(err, 2, 3), true);
  assert.equal(shouldRetryVoiceJoin(err, 3, 3), false);
  assert.equal(shouldRetryVoiceJoin(new Error('Missing permissions'), 1, 3), false);
});

test('voiceJoinRetryDelayMs uses short bounded backoff', () => {
  assert.equal(voiceJoinRetryDelayMs(1), 750);
  assert.equal(voiceJoinRetryDelayMs(2), 1500);
  assert.equal(voiceJoinRetryDelayMs(9), 3000);
});

test('shouldKeepPendingVoiceConnection keeps the final aborted handshake alive for late Ready', () => {
  const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

  assert.equal(shouldKeepPendingVoiceConnection(err, 3, 3), true);
  assert.equal(shouldKeepPendingVoiceConnection(err, 2, 3), false);
  assert.equal(shouldKeepPendingVoiceConnection(new Error('Missing permissions'), 3, 3), false);
});


test('shouldReuseVoiceConnection refuses destroyed connections', () => {
  const destroyed = {
    joinConfig: { guildId: 'guild-1', channelId: 'voice-1' },
    state: { status: 'destroyed' },
  };

  assert.equal(shouldReuseVoiceConnection(destroyed, 'guild-1', 'voice-1', 'ready'), false);
  assert.equal(shouldDestroyVoiceConnection(destroyed), false);
  assert.equal(shouldDestroyVoiceConnection({ state: { status: 'ready' } }), true);
});
