const DEFAULT_VOICE_CHANNEL_NAME = 'Voice Chat';

function channelTypeName(channel) {
  if (typeof channel?.type === 'string') return channel.type.toLowerCase();
  if (channel?.type === 2) return 'voice';
  if (channel?.type === 4) return 'category';
  if (channel?.type === 13) return 'stage';
  return String(channel?.type ?? '').toLowerCase();
}

export function isVoiceLikeChannel(channel) {
  const type = channelTypeName(channel);
  return type === 'voice' || type === 'stage' || type === '2' || type === '13';
}

export function isCategoryChannel(channel) {
  const type = channelTypeName(channel);
  return type === 'category' || type === '4';
}

export function buildVoiceCommands() {
  return [
    {
      name: 'voice-handoff',
      description: 'Join voice from this text channel and use the current text channel as context/transcript.',
    },
    {
      name: 'voice-defaults',
      description: 'Create a default Voice Chat channel in every category that does not have voice.',
    },
  ];
}

export function chooseVoiceChannelForHandoff({
  channels,
  textChannel,
  memberVoiceChannelId = null,
  defaultVoiceChannelName = DEFAULT_VOICE_CHANNEL_NAME,
}) {
  const list = Array.from(channels?.values ? channels.values() : channels || []);
  if (memberVoiceChannelId) {
    const current = list.find((channel) => channel.id === memberVoiceChannelId && isVoiceLikeChannel(channel));
    if (current) return { action: 'join', channel: current, reason: 'member-current-voice' };
  }

  const parentId = textChannel?.parentId;
  const sameCategoryVoice = list
    .filter((channel) => isVoiceLikeChannel(channel) && channel.parentId === parentId)
    .sort((a, b) => {
      const aDefault = a.name?.toLowerCase() === defaultVoiceChannelName.toLowerCase() ? 0 : 1;
      const bDefault = b.name?.toLowerCase() === defaultVoiceChannelName.toLowerCase() ? 0 : 1;
      return aDefault - bDefault || String(a.name || '').localeCompare(String(b.name || ''));
    })[0];
  if (sameCategoryVoice) return { action: 'join', channel: sameCategoryVoice, reason: 'same-category-voice' };

  if (parentId) return { action: 'create', parentId, name: defaultVoiceChannelName, reason: 'missing-category-voice' };

  const anyVoice = list.find((channel) => isVoiceLikeChannel(channel));
  if (anyVoice) return { action: 'join', channel: anyVoice, reason: 'fallback-any-voice' };
  return { action: 'none', reason: 'no-voice-channel-and-no-category' };
}

export function categoryNeedsDefaultVoiceChannel(categoryChannel, channels) {
  const list = Array.from(channels?.values ? channels.values() : channels || []);
  return !list.some((channel) => isVoiceLikeChannel(channel) && channel.parentId === categoryChannel.id);
}

export function categoryVoiceDefaultsPlan({ channels, defaultVoiceChannelName = DEFAULT_VOICE_CHANNEL_NAME }) {
  const list = Array.from(channels?.values ? channels.values() : channels || []);
  return list
    .filter((channel) => isCategoryChannel(channel))
    .filter((category) => categoryNeedsDefaultVoiceChannel(category, list))
    .map((category) => ({ parentId: category.id, name: defaultVoiceChannelName }));
}

export { DEFAULT_VOICE_CHANNEL_NAME };
