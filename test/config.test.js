import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVoiceConfig } from '../src/config.js';

test('fast mode lowers voice latency defaults while keeping Hermes quality model', () => {
  const config = resolveVoiceConfig({ VOICE_FAST_MODE: 'true' });

  assert.equal(config.fastMode, true);
  assert.equal(config.minAudioMs, 200);
  assert.equal(config.endSilenceMs, 275);
  assert.equal(config.textContextMaxMessages, 8);
  assert.equal(config.textContextFetchLimit, 30);
  assert.equal(config.hermesTimeoutMs, 15000);
  assert.equal(config.hermesModel, 'gpt-5.5');
  assert.equal(config.daveEncryption, false);
  assert.equal(config.voiceJoinAttempts, 3);
});

test('DAVE encryption can be explicitly enabled when Discord voice receive supports it', () => {
  const config = resolveVoiceConfig({ VOICE_DAVE_ENCRYPTION: 'true' });

  assert.equal(config.daveEncryption, true);
});

test('voice debug can be explicitly enabled for handshake diagnostics', () => {
  const config = resolveVoiceConfig({ VOICE_DEBUG: 'true' });

  assert.equal(config.voiceDebug, true);
});

test('barge-in is disabled by default and can be enabled explicitly', () => {
  assert.equal(resolveVoiceConfig({}).bargeIn, false);
  assert.equal(resolveVoiceConfig({ VOICE_BARGE_IN: 'true' }).bargeIn, true);
  assert.equal(resolveVoiceConfig({ VOICE_BARGE_IN: 'false' }).bargeIn, false);
});

test('barge-in requires a sustained speech hold by default', () => {
  assert.equal(resolveVoiceConfig({}).bargeInHoldMs, 650);
  assert.equal(resolveVoiceConfig({ VOICE_BARGE_IN_HOLD_MS: '900' }).bargeInHoldMs, 900);
});

test('post-playback speech ignore is disabled by default to avoid dropping follow-ups', () => {
  assert.equal(resolveVoiceConfig({}).ignoreAfterPlaybackMs, 0);
  assert.equal(resolveVoiceConfig({ VOICE_IGNORE_AFTER_PLAYBACK_MS: '1200' }).ignoreAfterPlaybackMs, 1200);
});

test('OpenAI voice model has a fast direct default and can be overridden', () => {
  const defaultConfig = resolveVoiceConfig({});
  const customConfig = resolveVoiceConfig({ VOICE_OPENAI_MODEL: 'gpt-4.1-mini' });

  assert.equal(defaultConfig.openaiModel, 'gpt-4o-mini');
  assert.equal(customConfig.openaiModel, 'gpt-4.1-mini');
});

test('voice replies are uncapped by default but can be overridden', () => {
  assert.equal(resolveVoiceConfig({}).responseMaxTokens, undefined);
  assert.equal(resolveVoiceConfig({ VOICE_RESPONSE_MAX_TOKENS: '450' }).responseMaxTokens, 450);
});

test('explicit env values override fast mode defaults', () => {
  const config = resolveVoiceConfig({
    VOICE_FAST_MODE: '1',
    VOICE_END_SILENCE_MS: '350',
    VOICE_MIN_AUDIO_MS: '250',
    VOICE_TEXT_CONTEXT_MAX_MESSAGES: '12',
    VOICE_TEXT_CONTEXT_FETCH_LIMIT: '40',
    VOICE_HERMES_TIMEOUT_MS: '22000',
    VOICE_HERMES_MODEL: 'custom-fast-model',
  });

  assert.equal(config.endSilenceMs, 350);
  assert.equal(config.minAudioMs, 250);
  assert.equal(config.textContextMaxMessages, 12);
  assert.equal(config.textContextFetchLimit, 40);
  assert.equal(config.hermesTimeoutMs, 22000);
  assert.equal(config.hermesModel, 'custom-fast-model');
});

test('normal mode gives GPT-5.5 enough time for slower voice turns', () => {
  const config = resolveVoiceConfig({});

  assert.equal(config.fastMode, false);
  assert.equal(config.minAudioMs, 300);
  assert.equal(config.endSilenceMs, 450);
  assert.equal(config.textContextMaxMessages, 24);
  assert.equal(config.textContextFetchLimit, 80);
  assert.equal(config.hermesTimeoutMs, 240000);
});
