import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVoiceCommands,
  chooseVoiceChannelForHandoff,
  categoryNeedsDefaultVoiceChannel,
  categoryVoiceDefaultsPlan,
} from '../src/handoff.js';

const voice = (overrides) => ({
  id: 'v1',
  name: 'voice-chat',
  type: 'voice',
  parentId: 'cat1',
  ...overrides,
});
const text = (overrides) => ({ id: 't1', name: 'chat', type: 'text', parentId: 'cat1', ...overrides });
const category = (overrides) => ({ id: 'cat1', name: 'Startup', type: 'category', ...overrides });

test('buildVoiceCommands exposes memorable slash commands', () => {
  const commands = buildVoiceCommands();
  assert.deepEqual(commands.map((command) => command.name), ['voice-handoff', 'voice-defaults']);
  assert.match(commands[0].description, /current text channel/i);
});

test('chooseVoiceChannelForHandoff prefers the user current voice channel', () => {
  const channels = [text({}), voice({ id: 'same-category' }), voice({ id: 'user-current', parentId: 'other' })];
  const selected = chooseVoiceChannelForHandoff({ channels, textChannel: text({}), memberVoiceChannelId: 'user-current' });
  assert.equal(selected.action, 'join');
  assert.equal(selected.channel.id, 'user-current');
});

test('chooseVoiceChannelForHandoff picks same-category voice channel when user is not in voice', () => {
  const selected = chooseVoiceChannelForHandoff({
    channels: [text({}), voice({ id: 'other', parentId: 'cat2' }), voice({ id: 'same', parentId: 'cat1' })],
    textChannel: text({ parentId: 'cat1' }),
  });
  assert.equal(selected.action, 'join');
  assert.equal(selected.channel.id, 'same');
});

test('chooseVoiceChannelForHandoff requests default voice creation when category has no voice channel', () => {
  const selected = chooseVoiceChannelForHandoff({ channels: [text({})], textChannel: text({ parentId: 'cat1' }) });
  assert.equal(selected.action, 'create');
  assert.equal(selected.parentId, 'cat1');
  assert.equal(selected.name, 'voice-chat');
});

test('categoryNeedsDefaultVoiceChannel detects categories without any voice channel', () => {
  assert.equal(categoryNeedsDefaultVoiceChannel(category({ id: 'cat1' }), [voice({ parentId: 'cat1' })]), false);
  assert.equal(categoryNeedsDefaultVoiceChannel(category({ id: 'cat2' }), [voice({ parentId: 'cat1' })]), true);
});

test('categoryVoiceDefaultsPlan creates one default voice channel per category that lacks voice', () => {
  const plan = categoryVoiceDefaultsPlan({
    channels: [category({ id: 'cat1' }), category({ id: 'cat2' }), voice({ parentId: 'cat1' })],
  });
  assert.deepEqual(plan, [{ parentId: 'cat2', name: 'voice-chat' }]);
});
