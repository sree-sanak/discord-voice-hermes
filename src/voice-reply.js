const DISCORD_MESSAGE_LIMIT = 2000;
const VOICE_REPLY_PREFIX = '🔊 **Hermes:** ';

export function formatDiscordVoiceReply(reply, limit = DISCORD_MESSAGE_LIMIT) {
  const text = String(reply || '').trim();
  const prefix = VOICE_REPLY_PREFIX;
  if (prefix.length + text.length <= limit) return `${prefix}${text}`;
  const available = Math.max(0, limit - prefix.length - 1);
  return `${prefix}${text.slice(0, available)}…`;
}

export function shouldSynthesizeForListener({ connected = false, hasListener = false } = {}) {
  return Boolean(connected && hasListener);
}
