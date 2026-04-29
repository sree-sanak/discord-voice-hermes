import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createContextCache,
  rememberTextMessage,
  selectRelevantTextContext,
  formatTextContextForPrompt,
} from '../src/context.js';

function msg(overrides = {}) {
  return {
    id: overrides.id || Math.random().toString(36).slice(2),
    guildId: 'guild-1',
    channelId: 'channel-startup',
    channelName: 'startup-ideas',
    parentId: 'category-startup',
    parentName: 'Startup',
    authorId: 'sree',
    authorName: 'Sree',
    content: 'default message',
    createdTimestamp: 1_000,
    bot: false,
    ...overrides,
  };
}

test('rememberTextMessage keeps non-command human messages and ignores bots/voice commands', () => {
  const cache = createContextCache({ maxMessages: 10 });

  rememberTextMessage(cache, msg({ id: '1', content: 'We should focus on founder-led sales.' }));
  rememberTextMessage(cache, msg({ id: '2', content: '!voice status' }));
  rememberTextMessage(cache, msg({ id: '3', content: 'bot noise', bot: true }));
  rememberTextMessage(cache, msg({ id: '4', content: '' }));

  const selected = selectRelevantTextContext(cache, {
    guildId: 'guild-1',
    voiceChannelParentId: 'category-startup',
    userId: 'sree',
    now: 2_000,
  });

  assert.equal(selected.messages.length, 1);
  assert.equal(selected.messages[0].content, 'We should focus on founder-led sales.');
});

test('selectRelevantTextContext prefers same-category recent channels with allowed user activity', () => {
  const cache = createContextCache({ maxMessages: 20 });

  rememberTextMessage(cache, msg({
    id: 'old-other',
    channelId: 'general',
    channelName: 'general',
    parentId: 'category-general',
    parentName: 'General',
    authorId: 'sree',
    content: 'unrelated general chat',
    createdTimestamp: 9_000,
  }));
  rememberTextMessage(cache, msg({
    id: 'startup-1',
    channelId: 'startup',
    channelName: 'startup-ideas',
    parentId: 'category-startup',
    parentName: 'Startup',
    authorId: 'teammate',
    authorName: 'Teammate',
    content: 'The wedge is SMB pay-later via QR.',
    createdTimestamp: 10_000,
  }));
  rememberTextMessage(cache, msg({
    id: 'startup-2',
    channelId: 'startup',
    channelName: 'startup-ideas',
    parentId: 'category-startup',
    parentName: 'Startup',
    authorId: 'sree',
    content: 'Need to test merchant settlement guarantees.',
    createdTimestamp: 11_000,
  }));

  const selected = selectRelevantTextContext(cache, {
    guildId: 'guild-1',
    voiceChannelParentId: 'category-startup',
    userId: 'sree',
    allowedUserIds: new Set(['sree']),
    now: 12_000,
  });

  assert.equal(selected.sourceLabel, '#startup-ideas');
  assert.deepEqual(selected.messages.map((m) => m.id), ['startup-1', 'startup-2']);
});

test('selectRelevantTextContext falls back to the user most recently active text channel', () => {
  const cache = createContextCache({ maxMessages: 20 });

  rememberTextMessage(cache, msg({
    id: 'investor',
    channelId: 'investors',
    channelName: 'investors',
    parentId: 'category-investors',
    authorId: 'sree',
    content: 'Investor update should emphasize velocity.',
    createdTimestamp: 20_000,
  }));

  const selected = selectRelevantTextContext(cache, {
    guildId: 'guild-1',
    voiceChannelParentId: 'category-empty',
    userId: 'sree',
    now: 21_000,
  });

  assert.equal(selected.sourceLabel, '#investors');
  assert.equal(selected.messages[0].content, 'Investor update should emphasize velocity.');
});

test('formatTextContextForPrompt produces compact TTS-safe context block', () => {
  const block = formatTextContextForPrompt({
    sourceLabel: '#startup-ideas',
    messages: [
      msg({ authorName: 'Sree', content: 'Let’s pick one ICP.', createdTimestamp: 10_000 }),
      msg({ authorName: 'Alex', content: 'Restaurants have urgent cashflow pain.', createdTimestamp: 11_000 }),
    ],
  });

  assert.match(block, /Relevant Discord text context from #startup-ideas/);
  assert.match(block, /Sree: Let’s pick one ICP/);
  assert.match(block, /Alex: Restaurants have urgent cashflow pain/);
});
