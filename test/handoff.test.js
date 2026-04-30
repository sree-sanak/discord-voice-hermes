import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVoiceCommands,
  chooseVoiceChannelForHandoff,
  shouldConnectImmediatelyForHandoff,
  categoryNeedsDefaultVoiceChannel,
  categoryVoiceDefaultsPlan,
  resolveCategoryIdForTextChannel,
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

test('resolveCategoryIdForTextChannel uses direct parent for normal text channels', () => {
  const selected = resolveCategoryIdForTextChannel(text({ parentId: 'cat1' }), [category({ id: 'cat1' })]);
  assert.equal(selected, 'cat1');
});

test('resolveCategoryIdForTextChannel resolves thread parent text channel to its category', () => {
  const selected = resolveCategoryIdForTextChannel(
    text({ id: 'thread1', type: 'thread', parentId: 'text-parent' }),
    [category({ id: 'cat1' }), text({ id: 'text-parent', parentId: 'cat1' })],
  );
  assert.equal(selected, 'cat1');
});

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
    channels: [category({ id: 'cat1' }), category({ id: 'cat2' }), text({}), voice({ id: 'other', parentId: 'cat2' }), voice({ id: 'same', parentId: 'cat1' })],
    textChannel: text({ parentId: 'cat1' }),
  });
  assert.equal(selected.action, 'join');
  assert.equal(selected.channel.id, 'same');
  assert.equal(shouldConnectImmediatelyForHandoff(selected, null), false);
});

test('shouldConnectImmediatelyForHandoff only joins immediately when the member is already in voice', () => {
  const selected = { action: 'join', channel: voice({ id: 'same' }), reason: 'same-category-voice' };
  const current = { action: 'join', channel: voice({ id: 'current' }), reason: 'member-current-voice' };

  assert.equal(shouldConnectImmediatelyForHandoff(selected, null), false);
  assert.equal(shouldConnectImmediatelyForHandoff(current, 'current'), true);
});

test('chooseVoiceChannelForHandoff does not create voice channel under a thread parent text channel', () => {
  const selected = chooseVoiceChannelForHandoff({
    channels: [category({ id: 'cat1' }), text({ id: 'text-parent', parentId: 'cat1' })],
    textChannel: text({ id: 'thread1', type: 'thread', parentId: 'text-parent' }),
  });
  assert.equal(selected.action, 'create');
  assert.equal(selected.parentId, 'cat1');
});

test('chooseVoiceChannelForHandoff requests default voice creation when category has no voice channel', () => {
  const selected = chooseVoiceChannelForHandoff({ channels: [category({ id: 'cat1' }), text({})], textChannel: text({ parentId: 'cat1' }) });
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
