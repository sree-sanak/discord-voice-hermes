const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function isEnabled(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return !FALSE_VALUES.has(String(value).trim().toLowerCase());
}

function numberFromEnv(env, key, defaultValue) {
  const raw = env[key];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function resolveVoiceConfig(env = process.env) {
  const fastMode = isEnabled(env.VOICE_FAST_MODE, false);
  const normal = {
    minAudioMs: 300,
    endSilenceMs: 450,
    hermesTimeoutMs: 25000,
    textContextMaxMessages: 24,
    textContextFetchLimit: 80,
  };
  const fast = {
    minAudioMs: 200,
    endSilenceMs: 275,
    hermesTimeoutMs: 15000,
    textContextMaxMessages: 8,
    textContextFetchLimit: 30,
  };
  const defaults = fastMode ? fast : normal;

  return {
    discordToken: env.DISCORD_VOICE_BOT_TOKEN || env.DISCORD_BOT_TOKEN,
    openaiKey: env.VOICE_TOOLS_OPENAI_KEY || env.OPENAI_API_KEY,
    prefix: env.VOICE_COMMAND_PREFIX || '!voice',
    fastMode,
    sttModel: env.VOICE_STT_MODEL || 'gpt-4o-mini-transcribe',
    ttsModel: env.VOICE_TTS_MODEL || 'tts-1',
    ttsVoice: env.VOICE_TTS_VOICE || 'alloy',
    minAudioMs: numberFromEnv(env, 'VOICE_MIN_AUDIO_MS', defaults.minAudioMs),
    endSilenceMs: numberFromEnv(env, 'VOICE_END_SILENCE_MS', defaults.endSilenceMs),
    hermesBin: env.VOICE_HERMES_BIN || 'hermes',
    hermesSessionPrefix: env.VOICE_HERMES_SESSION || 'discord-voice',
    hermesProvider: env.VOICE_HERMES_PROVIDER || 'openai-codex',
    hermesModel: env.VOICE_HERMES_MODEL || 'gpt-5.5',
    responseBackend: (env.VOICE_RESPONSE_BACKEND || 'hermes').toLowerCase(),
    openaiModel: env.VOICE_OPENAI_MODEL || 'gpt-4o-mini',
    hermesToolsets: env.VOICE_HERMES_TOOLSETS || '',
    hermesTimeoutMs: numberFromEnv(env, 'VOICE_HERMES_TIMEOUT_MS', defaults.hermesTimeoutMs),
    codexBin: env.VOICE_CODEX_BIN || 'codex',
    codexHome: env.VOICE_CODEX_HOME || '/var/lib/hermes-codex',
    codexModel: env.VOICE_CODEX_MODEL || 'gpt-5.5',
    codexTimeoutMs: numberFromEnv(env, 'VOICE_CODEX_TIMEOUT_MS', 60000),
    daveEncryption: isEnabled(env.VOICE_DAVE_ENCRYPTION, false),
    voiceDebug: isEnabled(env.VOICE_DEBUG, false),
    bargeIn: isEnabled(env.VOICE_BARGE_IN, true),
    bargeInHoldMs: numberFromEnv(env, 'VOICE_BARGE_IN_HOLD_MS', 650),
    decryptionFailureTolerance: numberFromEnv(env, 'VOICE_DECRYPTION_FAILURE_TOLERANCE', 1000),
    voiceJoinAttempts: numberFromEnv(env, 'VOICE_JOIN_ATTEMPTS', 3),
    autoFollow: isEnabled(env.VOICE_AUTO_FOLLOW, true),
    ignoreAfterPlaybackMs: numberFromEnv(env, 'VOICE_IGNORE_AFTER_PLAYBACK_MS', 1200),
    autoTextContext: isEnabled(env.VOICE_AUTO_TEXT_CONTEXT, true),
    textContextMaxMessages: numberFromEnv(env, 'VOICE_TEXT_CONTEXT_MAX_MESSAGES', defaults.textContextMaxMessages),
    textContextFetchLimit: numberFromEnv(env, 'VOICE_TEXT_CONTEXT_FETCH_LIMIT', defaults.textContextFetchLimit),
    handoffContextMaxMessages: numberFromEnv(env, 'VOICE_HANDOFF_CONTEXT_MAX_MESSAGES', 60),
    textContextMaxAgeMs: numberFromEnv(env, 'VOICE_TEXT_CONTEXT_MAX_AGE_MS', 6 * 60 * 60 * 1000),
  };
}
