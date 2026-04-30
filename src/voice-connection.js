export function shouldReuseVoiceConnection(existing, guildId, channelId, readyStatus) {
  return Boolean(
    existing
      && existing.joinConfig?.guildId === guildId
      && existing.joinConfig?.channelId === channelId
      && existing.state?.status === readyStatus
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

export function voiceJoinRetryDelayMs(attempt) {
  return Math.min(3000, Math.max(1, attempt) * 750);
}

export function formatVoiceJoinError(err, channelName, attempts = 1) {
  if (isVoiceJoinAbortError(err)) {
    return `Could not join **${channelName}** after ${attempts} attempt(s). Discord did not finish the voice handshake. I cleared the stale connection; wait a few seconds and try \`/voice-handoff\` again, or join the voice channel first so I can auto-follow you.`;
  }
  return err?.message || String(err);
}
