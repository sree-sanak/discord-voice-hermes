export function isDestroyedVoiceConnection(connection) {
  return connection?.state?.status === 'destroyed'
    || connection?.state?.status === 'Destroyed'
    || connection?._state?.status === 'destroyed';
}

export function shouldDestroyVoiceConnection(connection) {
  return Boolean(connection && !isDestroyedVoiceConnection(connection));
}

export function shouldReuseVoiceConnection(existing, guildId, channelId, readyStatus) {
  return Boolean(
    existing
      && !isDestroyedVoiceConnection(existing)
      && existing.joinConfig?.guildId === guildId
      && existing.joinConfig?.channelId === channelId
      && existing.state?.status === readyStatus
  );
}

export function shouldReplaceStaleVoiceConnection(existing, guildId, channelId, readyStatus) {
  return Boolean(
    existing
      && !isDestroyedVoiceConnection(existing)
      && existing.joinConfig?.guildId === guildId
      && existing.joinConfig?.channelId === channelId
      && existing.state?.status !== readyStatus
  );
}

export function isVoiceJoinAbortError(err) {
  return err?.name === 'AbortError'
    || err?.code === 'ABORT_ERR'
    || /operation was aborted/i.test(err?.message || '');
}

export function shouldRetryVoiceJoin(err, attempt, maxAttempts) {
  return isVoiceJoinAbortError(err) && attempt < maxAttempts;
}

export function shouldKeepPendingVoiceConnection(err, attempt, maxAttempts) {
  return isVoiceJoinAbortError(err) && attempt >= maxAttempts;
}

export function voiceJoinRetryDelayMs(attempt) {
  return Math.min(3000, Math.max(1, attempt) * 750);
}

export function shouldDeferAutoLeave(state) {
  return Boolean(state?.playing || state?.busy);
}

export function formatVoiceJoinError(err, channelName, attempts = 1) {
  if (isVoiceJoinAbortError(err)) {
    return `Could not join **${channelName}** after ${attempts} attempt(s). Discord did not finish the voice handshake. I cleared the stale connection; wait a few seconds and try \`/voice-handoff\` again, or join the voice channel first so I can auto-follow you.`;
  }
  return err?.message || String(err);
}
