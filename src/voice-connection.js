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

export function formatVoiceJoinError(err, channelName) {
  if (isVoiceJoinAbortError(err)) {
    return `Timed out joining **${channelName}**. I cleared the stale Discord voice connection; please run \`/voice-handoff\` again if I am not already in the channel.`;
  }
  return err?.message || String(err);
}
