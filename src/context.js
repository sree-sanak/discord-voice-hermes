const DEFAULT_MAX_MESSAGES = 500;
const DEFAULT_MAX_CONTEXT_MESSAGES = 24;
const DEFAULT_MAX_MESSAGE_CHARS = 280;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function createContextCache(options = {}) {
  return {
    maxMessages: options.maxMessages || DEFAULT_MAX_MESSAGES,
    messages: [],
  };
}

export function normalizeMessage(raw) {
  const content = String(raw.content || '').replace(/\s+/g, ' ').trim();
  return {
    id: raw.id,
    guildId: raw.guildId,
    channelId: raw.channelId,
    channelName: raw.channelName || raw.channelId,
    parentId: raw.parentId || null,
    parentName: raw.parentName || null,
    authorId: raw.authorId,
    authorName: raw.authorName || raw.authorId,
    content,
    createdTimestamp: Number(raw.createdTimestamp || Date.now()),
    bot: Boolean(raw.bot),
  };
}

export function shouldRememberMessage(raw, options = {}) {
  const message = normalizeMessage(raw);
  const prefix = options.commandPrefix || '!voice';
  if (message.bot) return false;
  if (!message.guildId || !message.channelId || !message.authorId) return false;
  if (!message.content) return false;
  if (message.content.startsWith(prefix)) return false;
  return true;
}

export function rememberTextMessage(cache, raw, options = {}) {
  if (!shouldRememberMessage(raw, options)) return false;
  const message = normalizeMessage(raw);
  cache.messages.push(message);
  if (cache.messages.length > cache.maxMessages) {
    cache.messages.splice(0, cache.messages.length - cache.maxMessages);
  }
  return true;
}

function scoreMessage(message, criteria) {
  let score = 0;
  if (criteria.voiceChannelParentId && message.parentId === criteria.voiceChannelParentId) score += 1000;
  if (criteria.userId && message.authorId === criteria.userId) score += 200;
  if (criteria.allowedUserIds?.has?.(message.authorId)) score += 120;
  score += Math.floor(message.createdTimestamp / 1000_000);
  return score;
}

function sourceKey(message) {
  return message.channelId;
}

function sourceLabelFor(messages) {
  const first = messages[0];
  return first?.channelName ? `#${first.channelName}` : 'recent Discord text';
}

export function selectRelevantTextContext(cache, criteria = {}) {
  const now = Number(criteria.now || Date.now());
  const maxAgeMs = Number(criteria.maxAgeMs || DEFAULT_MAX_AGE_MS);
  const maxMessages = Number(criteria.maxMessages || DEFAULT_MAX_CONTEXT_MESSAGES);
  const candidates = cache.messages
    .filter((message) => message.guildId === criteria.guildId)
    .filter((message) => !criteria.channelId || message.channelId === criteria.channelId)
    .filter((message) => now - message.createdTimestamp <= maxAgeMs)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  if (candidates.length === 0) return null;

  const groups = new Map();
  for (const message of candidates) {
    const key = sourceKey(message);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }

  let best = null;
  for (const messages of groups.values()) {
    const score = messages.reduce((sum, message) => sum + scoreMessage(message, criteria), 0)
      + Math.max(...messages.map((m) => m.createdTimestamp)) / 1000;
    if (!best || score > best.score) best = { score, messages };
  }

  if (!best) return null;
  const messages = best.messages.slice(-maxMessages);
  return {
    sourceLabel: sourceLabelFor(messages),
    messages,
  };
}

export function formatTextContextForPrompt(selection, options = {}) {
  if (!selection?.messages?.length) return '';
  const maxMessageChars = Number(options.maxMessageChars || DEFAULT_MAX_MESSAGE_CHARS);
  const lines = selection.messages.map((message) => {
    const content = message.content.length > maxMessageChars
      ? `${message.content.slice(0, maxMessageChars - 1)}…`
      : message.content;
    return `${message.authorName}: ${content}`;
  });
  return [
    `Relevant Discord text context from ${selection.sourceLabel}:`,
    ...lines,
  ].join('\n');
}
