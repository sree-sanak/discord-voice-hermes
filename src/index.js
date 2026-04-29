import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import prism from 'prism-media';
import OpenAI from 'openai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import {
  createContextCache,
  formatTextContextForPrompt,
  rememberTextMessage,
  selectRelevantTextContext,
} from './context.js';
import { resolveVoiceConfig } from './config.js';
import {
  DEFAULT_VOICE_CHANNEL_NAME,
  buildVoiceCommands,
  categoryVoiceDefaultsPlan,
  chooseVoiceChannelForHandoff,
} from './handoff.js';

// Load a local .env first, then the main Hermes env file when run alongside Hermes.
const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
dotenvConfig({ path: path.join(process.cwd(), '.env'), override: false, quiet: true });
dotenvConfig({ path: path.join(hermesHome, '.env'), override: false, quiet: true });

const execFileAsync = promisify(execFile);

const config = resolveVoiceConfig(process.env);
const DISCORD_TOKEN = config.discordToken;
const OPENAI_KEY = config.openaiKey;
const PREFIX = config.prefix;
const FAST_MODE = config.fastMode;
const STT_MODEL = config.sttModel;
const TTS_MODEL = config.ttsModel;
const TTS_VOICE = config.ttsVoice;
const MIN_AUDIO_MS = config.minAudioMs;
const END_SILENCE_MS = config.endSilenceMs;
const HERMES_BIN = config.hermesBin;
const HERMES_SESSION_PREFIX = config.hermesSessionPrefix;
const HERMES_PROVIDER = config.hermesProvider;
const HERMES_MODEL = config.hermesModel;
const RESPONSE_BACKEND = config.responseBackend;
const HERMES_TOOLSETS = config.hermesToolsets;
const MAX_HERMES_MS = config.hermesTimeoutMs;
const CODEX_BIN = config.codexBin;
const CODEX_HOME = config.codexHome;
const CODEX_MODEL = config.codexModel;
const MAX_CODEX_MS = config.codexTimeoutMs;
const DAVE_ENCRYPTION = config.daveEncryption;
const DECRYPTION_FAILURE_TOLERANCE = config.decryptionFailureTolerance;
const AUTO_FOLLOW = config.autoFollow;
const IGNORE_AFTER_PLAYBACK_MS = config.ignoreAfterPlaybackMs;
const AUTO_TEXT_CONTEXT = config.autoTextContext;
const TEXT_CONTEXT_MAX_MESSAGES = config.textContextMaxMessages;
const TEXT_CONTEXT_FETCH_LIMIT = config.textContextFetchLimit;
const TEXT_CONTEXT_MAX_AGE_MS = config.textContextMaxAgeMs;
const DEFAULT_VOICE_CHANNEL = process.env.VOICE_DEFAULT_CHANNEL_NAME || DEFAULT_VOICE_CHANNEL_NAME;

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_BOT_TOKEN or DISCORD_VOICE_BOT_TOKEN');
if (!OPENAI_KEY) throw new Error('Missing OPENAI_API_KEY or VOICE_TOOLS_OPENAI_KEY');

const allowedUsers = new Set(
  (process.env.DISCORD_VOICE_ALLOWED_USERS || process.env.DISCORD_ALLOWED_USERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const openai = new OpenAI({ apiKey: OPENAI_KEY });
const tmpRoot = path.join(os.tmpdir(), 'discord-voice-hermes');
fs.mkdirSync(tmpRoot, { recursive: true });
const textContextCache = createContextCache();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

const sessions = new Map();

function getSession(guildId) {
  if (!sessions.has(guildId)) {
    const player = createAudioPlayer();
    const state = {
      guildId,
      connection: null,
      player,
      textChannel: null,
      hermesSessionId: null,
      busy: false,
      playing: false,
      queued: [],
      lastTranscript: '',
      startedAt: Date.now(),
      receiverAttached: false,
      ignoredUntil: 0,
      history: [],
      textContext: null,
    };
    player.on(AudioPlayerStatus.Playing, () => { state.playing = true; });
    player.on(AudioPlayerStatus.Idle, () => {
      state.playing = false;
      state.ignoredUntil = Date.now() + IGNORE_AFTER_PLAYBACK_MS;
    });
    player.on('error', (err) => console.error('[audio-player]', err));
    sessions.set(guildId, state);
  }
  return sessions.get(guildId);
}

function isAllowed(userId) {
  return allowedUsers.size === 0 || allowedUsers.has(userId);
}

function rememberDiscordMessage(message) {
  return rememberTextMessage(textContextCache, {
    id: message.id,
    guildId: message.guild?.id,
    channelId: message.channel?.id,
    channelName: message.channel?.name,
    parentId: message.channel?.parentId,
    parentName: message.channel?.parent?.name,
    authorId: message.author?.id,
    authorName: message.author?.username || message.author?.globalName,
    content: message.content,
    createdTimestamp: message.createdTimestamp,
    bot: message.author?.bot,
  }, { commandPrefix: PREFIX });
}

function canReadTextChannel(channel) {
  return typeof channel?.isTextBased === 'function'
    && channel.isTextBased()
    && typeof channel.messages?.fetch === 'function';
}

async function fetchRecentTextContext(guild, voiceChannel, userId) {
  if (!AUTO_TEXT_CONTEXT) return null;
  const readable = guild.channels.cache
    .filter((channel) => canReadTextChannel(channel))
    .filter((channel) => !voiceChannel?.parentId || channel.parentId === voiceChannel.parentId);
  const channels = readable.size ? readable : guild.channels.cache.filter((channel) => canReadTextChannel(channel));

  await Promise.allSettled(channels.map(async (channel) => {
    const messages = await channel.messages.fetch({ limit: TEXT_CONTEXT_FETCH_LIMIT });
    for (const message of messages.values()) rememberDiscordMessage(message);
  }));

  return selectRelevantTextContext(textContextCache, {
    guildId: guild.id,
    voiceChannelParentId: voiceChannel?.parentId,
    userId,
    allowedUserIds: allowedUsers,
    now: Date.now(),
    maxAgeMs: TEXT_CONTEXT_MAX_AGE_MS,
    maxMessages: TEXT_CONTEXT_MAX_MESSAGES,
  });
}

async function refreshTextContextForVoice(state, guild, voiceChannel, userId) {
  state.textContext = await fetchRecentTextContext(guild, voiceChannel, userId);
  return state.textContext;
}

async function setExplicitTextContextFromChannel(state, channel) {
  if (!canReadTextChannel(channel)) return null;
  const messages = await channel.messages.fetch({ limit: TEXT_CONTEXT_FETCH_LIMIT });
  for (const message of messages.values()) rememberDiscordMessage(message);
  const selected = textContextCache.messages
    .filter((message) => message.guildId === channel.guild?.id)
    .filter((message) => message.channelId === channel.id)
    .filter((message) => Date.now() - message.createdTimestamp <= TEXT_CONTEXT_MAX_AGE_MS)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(-TEXT_CONTEXT_MAX_MESSAGES);
  state.textContext = selected.length ? {
    sourceLabel: `#${channel.name}`,
    messages: selected,
  } : null;
  return state.textContext;
}

async function createDefaultVoiceChannel(guild, parentId) {
  return guild.channels.create({
    name: DEFAULT_VOICE_CHANNEL,
    type: ChannelType.GuildVoice,
    parent: parentId,
    reason: 'Discord Voice Hermes default category voice channel',
  });
}

async function resolveHandoffVoiceChannel(guild, textChannel, member) {
  const decision = chooseVoiceChannelForHandoff({
    channels: guild.channels.cache,
    textChannel,
    memberVoiceChannelId: member?.voice?.channelId,
    defaultVoiceChannelName: DEFAULT_VOICE_CHANNEL,
  });
  if (decision.action === 'join') return { channel: decision.channel, created: false, reason: decision.reason };
  if (decision.action === 'create') {
    const channel = await createDefaultVoiceChannel(guild, decision.parentId);
    return { channel, created: true, reason: decision.reason };
  }
  throw new Error('No voice channel found, and this text channel is not inside a category where I can create one.');
}

function pcmDurationMs(bytes, sampleRate = 48000, channels = 2, bytesPerSample = 2) {
  return (bytes / (sampleRate * channels * bytesPerSample)) * 1000;
}

function wavHeader(dataBytes, sampleRate = 48000, channels = 2, bitDepth = 16) {
  const blockAlign = (channels * bitDepth) / 8;
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

async function recordUtterance(connection, userId) {
  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: END_SILENCE_MS },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const chunks = [];
  decoder.on('data', (chunk) => chunks.push(chunk));
  await pipeline(opusStream, decoder).catch((err) => {
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err;
  });
  const pcm = Buffer.concat(chunks);
  const duration = pcmDurationMs(pcm.length);
  if (duration < MIN_AUDIO_MS) return null;
  const id = `${Date.now()}-${userId}`;
  const wavPath = path.join(tmpRoot, `${id}.wav`);
  fs.writeFileSync(wavPath, Buffer.concat([wavHeader(pcm.length), pcm]));
  return { wavPath, duration };
}

async function transcribe(wavPath) {
  const result = await openai.audio.transcriptions.create({
    model: STT_MODEL,
    file: fs.createReadStream(wavPath),
  });
  return (result.text || '').trim();
}

function cleanHermesOutput(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('session_id:') && !line.startsWith('↻ Resumed session'))
    .join('\n')
    .trim();
}

function extractSessionId(stdout) {
  const match = stdout.match(/session_id:\s*([A-Za-z0-9_\-]+)/);
  return match?.[1] || null;
}

function buildVoicePrompt(state, transcript, username) {
  const history = state.history
    .slice(-8)
    .map((turn) => `${turn.role}: ${turn.text}`)
    .join('\n');
  const textContext = formatTextContextForPrompt(state.textContext);
  return [
    'You are Hermes speaking in a Discord voice channel. Reply conversationally and briefly, optimized for TTS.',
    'Avoid markdown tables/code unless explicitly requested. Keep most replies under 5 sentences.',
    textContext ? `Use this recent Discord text context when relevant:\n${textContext}` : '',
    history ? `Recent voice conversation:\n${history}` : '',
    `Speaker: ${username}`,
    `User said: ${transcript}`,
  ].filter(Boolean).join('\n');
}

async function askHermes(state, transcript, username) {
  const prompt = buildVoicePrompt(state, transcript, username);
  const args = [];
  if (state.hermesSessionId) args.push('--resume', state.hermesSessionId);
  args.push('chat', '-Q');
  if (HERMES_PROVIDER) args.push('--provider', HERMES_PROVIDER);
  if (HERMES_MODEL) args.push('-m', HERMES_MODEL);
  if (HERMES_TOOLSETS) args.push('-t', HERMES_TOOLSETS);
  args.push('-q', prompt);

  const { stdout, stderr } = await execFileAsync(HERMES_BIN, args, {
    timeout: MAX_HERMES_MS,
    maxBuffer: 1024 * 1024 * 4,
    env: { ...process.env, HERMES_HOME: process.env.HERMES_HOME || '/root/.hermes' },
  });
  const sid = extractSessionId(stdout);
  if (sid) state.hermesSessionId = sid;
  const text = cleanHermesOutput(stdout);
  if (!text) throw new Error(`Hermes returned empty response. stderr=${stderr || ''}`);
  return text;
}

async function askCodex(state, transcript, username) {
  const prompt = buildVoicePrompt(state, transcript, username);
  const outPath = path.join(tmpRoot, `${Date.now()}-codex-response.txt`);
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--model', CODEX_MODEL,
    '--output-last-message', outPath,
    prompt,
  ];
  const { stderr } = await execFileAsync(CODEX_BIN, args, {
    timeout: MAX_CODEX_MS,
    maxBuffer: 1024 * 1024 * 4,
    cwd: '/root/.hermes/discord-voice-hermes',
    env: { ...process.env, CODEX_HOME },
  });
  const text = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').trim() : '';
  fs.rm(outPath, { force: true }, () => {});
  if (!text) throw new Error(`Codex returned empty response. stderr=${stderr || ''}`);
  return text;
}

async function askAssistant(state, transcript, username) {
  if (RESPONSE_BACKEND === 'codex') return askCodex(state, transcript, username);
  return askHermes(state, transcript, username);
}

async function synthesize(text) {
  const id = `${Date.now()}-reply`;
  const outPath = path.join(tmpRoot, `${id}.mp3`);
  const response = await openai.audio.speech.create({
    model: TTS_MODEL,
    voice: TTS_VOICE,
    input: text.slice(0, 4000),
    format: 'mp3',
  });
  const audio = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outPath, audio);
  return outPath;
}

async function playFile(state, audioPath) {
  const resource = createAudioResource(audioPath);
  state.player.play(resource);
  state.connection.subscribe(state.player);
  await entersState(state.player, AudioPlayerStatus.Idle, 120000).catch(() => {});
}

async function handleSpeech(state, userId) {
  if (state.busy || state.playing || !state.connection || Date.now() < state.ignoredUntil) return;
  state.busy = true;
  let wavPath = null;
  let ttsPath = null;
  try {
    const user = await client.users.fetch(userId).catch(() => null);
    const username = user?.username || userId;
    const recorded = await recordUtterance(state.connection, userId);
    if (!recorded) return;
    wavPath = recorded.wavPath;

    const transcript = await transcribe(wavPath);
    if (!transcript || transcript.length < 2) return;
    if (/^(you|um|uh|hm|hmm|yeah|okay|ok|thanks?)\.?$/i.test(transcript.trim())) return;
    state.lastTranscript = transcript;
    console.log(`[stt] ${username}: ${transcript}`);
    state.textChannel?.send(`🎙️ **${username}:** ${transcript}`).catch((err) => console.warn('[discord send transcript]', err.message));

    console.log('[pipeline] asking Hermes...');
    const reply = await askAssistant(state, transcript, username);
    console.log(`[${RESPONSE_BACKEND}] ${reply}`);
    state.textChannel?.send(`🔊 **Hermes:** ${reply}`).catch((err) => console.warn('[discord send reply]', err.message));
    state.history.push({ role: username, text: transcript }, { role: 'Hermes', text: reply });
    state.history = state.history.slice(-12);

    console.log('[pipeline] synthesizing TTS...');
    ttsPath = await synthesize(reply);
    await playFile(state, ttsPath);
  } catch (err) {
    console.error('[voice pipeline]', err);
    await state.textChannel?.send(`⚠️ Voice pipeline error: ${err.message}`).catch(() => {});
  } finally {
    state.busy = false;
    for (const p of [wavPath, ttsPath]) {
      if (p) fs.rm(p, { force: true }, () => {});
    }
  }
}

function attachReceiver(state) {
  if (state.receiverAttached) return;
  state.receiverAttached = true;
  state.connection.receiver.speaking.on('start', (userId) => {
    if (userId === client.user?.id) return;
    if (!isAllowed(userId)) return;
    handleSpeech(state, userId);
  });
}

async function connectToVoiceChannel(state, guild, voiceChannel) {
  const existing = getVoiceConnection(guild.id);
  if (existing) existing.destroy();

  state.receiverAttached = false;
  state.connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
    daveEncryption: DAVE_ENCRYPTION,
    decryptionFailureTolerance: DECRYPTION_FAILURE_TOLERANCE,
    debug: false,
  });
  state.connection.on(VoiceConnectionStatus.Disconnected, () => {
    state.connection = null;
    state.receiverAttached = false;
  });
  await entersState(state.connection, VoiceConnectionStatus.Ready, 30000);
  attachReceiver(state);
}

async function join(message) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) return message.reply('Join a voice channel first, then run `!voice join`.');
  if (!isAllowed(message.author.id)) return message.reply('You are not in the voice allowlist.');

  const state = getSession(message.guild.id);
  state.textChannel = message.channel;

  await connectToVoiceChannel(state, message.guild, voiceChannel);
  const context = await refreshTextContextForVoice(state, message.guild, voiceChannel, message.author.id).catch((err) => {
    console.warn('[text context fetch]', err.message);
    return null;
  });
  const contextNote = context ? ` Using recent text context from ${context.sourceLabel}.` : '';
  return message.reply(`Joined **${voiceChannel.name}**. Speak normally; I will respond after ~${END_SILENCE_MS}ms of silence.${contextNote}`);
}

async function leave(message) {
  const state = getSession(message.guild.id);
  const connection = getVoiceConnection(message.guild.id) || state.connection;
  if (connection) connection.destroy();
  state.connection = null;
  return message.reply('Left the voice channel.');
}

async function status(message) {
  const state = getSession(message.guild.id);
  return message.reply([
    '**Hermes voice status**',
    `connected: ${Boolean(state.connection)}`,
    `busy: ${state.busy}`,
    `playing: ${state.playing}`,
    `allowedUsers: ${allowedUsers.size || 'any'}`,
    `fastMode: ${FAST_MODE}`,
    `stt: ${STT_MODEL}`,
    `tts: ${TTS_MODEL}/${TTS_VOICE}`,
    `endSilenceMs: ${END_SILENCE_MS}`,
    `minAudioMs: ${MIN_AUDIO_MS}`,
    `textContextMaxMessages: ${TEXT_CONTEXT_MAX_MESSAGES}`,
    `textContextFetchLimit: ${TEXT_CONTEXT_FETCH_LIMIT}`,
    `autoFollow: ${AUTO_FOLLOW}`,
    `autoTextContext: ${AUTO_TEXT_CONTEXT}`,
    `textContext: ${state.textContext?.sourceLabel || 'none'}`,
    `ignoreAfterPlaybackMs: ${IGNORE_AFTER_PLAYBACK_MS}`,
    `daveEncryption: ${DAVE_ENCRYPTION}`,
    `decryptionFailureTolerance: ${DECRYPTION_FAILURE_TOLERANCE}`,
    `responseBackend: ${RESPONSE_BACKEND}`,
    `codexModel: ${CODEX_MODEL}`,
    `hermesSessionId: ${state.hermesSessionId || 'not started'}`,
    `lastTranscript: ${state.lastTranscript || 'none'}`,
  ].join('\n'));
}

async function handoff({ guild, textChannel, member, userId }) {
  if (!isAllowed(userId)) throw new Error('You are not in the voice allowlist.');
  const state = getSession(guild.id);
  state.textChannel = textChannel;

  const { channel: voiceChannel, created } = await resolveHandoffVoiceChannel(guild, textChannel, member);
  await connectToVoiceChannel(state, guild, voiceChannel);
  const context = await setExplicitTextContextFromChannel(state, textChannel).catch((err) => {
    console.warn('[explicit text context fetch]', err.message);
    return null;
  });
  const createdNote = created ? ` Created **${voiceChannel.name}** first.` : '';
  const contextNote = context ? ` Locked context/transcripts to #${textChannel.name}.` : ` I will mirror transcripts in #${textChannel.name}.`;
  return `Joined **${voiceChannel.name}** from #${textChannel.name}.${createdNote}${contextNote}`;
}

async function ensureVoiceDefaults(guild) {
  const plan = categoryVoiceDefaultsPlan({
    channels: guild.channels.cache,
    defaultVoiceChannelName: DEFAULT_VOICE_CHANNEL,
  });
  const created = [];
  for (const item of plan) {
    const channel = await createDefaultVoiceChannel(guild, item.parentId);
    created.push(channel);
  }
  return created;
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  if (!['voice-handoff', 'voice-defaults'].includes(interaction.commandName)) return;
  try {
    await interaction.deferReply();
    if (interaction.commandName === 'voice-handoff') {
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => interaction.member);
      const result = await handoff({
        guild: interaction.guild,
        textChannel: interaction.channel,
        member,
        userId: interaction.user.id,
      });
      return interaction.editReply(result);
    }
    if (!isAllowed(interaction.user.id)) throw new Error('You are not in the voice allowlist.');
    const created = await ensureVoiceDefaults(interaction.guild);
    const note = created.length
      ? `Created ${created.length} default voice channel(s): ${created.map((channel) => `**${channel.name}**`).join(', ')}`
      : 'Every category already has at least one voice channel.';
    return interaction.editReply(note);
  } catch (err) {
    console.error('[interaction]', err);
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(`Voice command failed: ${err.message}`).catch(() => {});
    }
    return interaction.reply({ content: `Voice command failed: ${err.message}`, ephemeral: true }).catch(() => {});
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  rememberDiscordMessage(message);
  if (!message.content.startsWith(PREFIX)) return;
  const arg = message.content.slice(PREFIX.length).trim().toLowerCase();
  try {
    if (arg === 'join') return await join(message);
    if (arg === 'handoff' || arg === 'here') return message.reply(await handoff({
      guild: message.guild,
      textChannel: message.channel,
      member: message.member,
      userId: message.author.id,
    }));
    if (arg === 'leave') return await leave(message);
    if (arg === 'status' || arg === '') return await status(message);
    return message.reply(`Commands: \`${PREFIX} join\`, \`${PREFIX} handoff\`, \`${PREFIX} leave\`, \`${PREFIX} status\``);
  } catch (err) {
    console.error('[command]', err);
    return message.reply(`Voice command failed: ${err.message}`);
  }
});

client.on('interactionCreate', handleInteraction);
client.on('error', (err) => console.error('[discord client]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled rejection]', err));

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!AUTO_FOLLOW || newState.member?.user?.bot) return;
  const userId = newState.id;
  if (!isAllowed(userId)) return;

  const guild = newState.guild || oldState.guild;
  const state = getSession(guild.id);
  const connection = getVoiceConnection(guild.id) || state.connection;

  try {
    if (newState.channel && (!connection || connection.joinConfig?.channelId !== newState.channel.id)) {
      await connectToVoiceChannel(state, guild, newState.channel);
      const context = await refreshTextContextForVoice(state, guild, newState.channel, userId).catch((err) => {
        console.warn('[text context fetch]', err.message);
        return null;
      });
      const contextNote = context ? ` Using recent text context from ${context.sourceLabel}.` : '';
      await state.textChannel?.send(`🔊 Auto-joined **${newState.channel.name}**.${contextNote}`).catch(() => {});
      return;
    }

    if (!newState.channel && connection) {
      const connectedChannel = guild.channels.cache.get(connection.joinConfig?.channelId);
      const hasAllowedHuman = connectedChannel?.members?.some((member) => !member.user.bot && isAllowed(member.id));
      if (!hasAllowedHuman) {
        connection.destroy();
        state.connection = null;
        state.receiverAttached = false;
        await state.textChannel?.send('🔇 Auto-left voice channel.').catch(() => {});
      }
    }
  } catch (err) {
    console.error('[voice auto-follow]', err);
  }
});

client.once('clientReady', async () => {
  console.log(`Discord Voice Hermes ready as ${client.user.tag}`);
  console.log(`Prefix: ${PREFIX}; allowed users: ${allowedUsers.size || 'any'}; fastMode=${FAST_MODE}; STT=${STT_MODEL}; TTS=${TTS_MODEL}/${TTS_VOICE}; Hermes=${HERMES_PROVIDER}/${HERMES_MODEL}; toolsets=${HERMES_TOOLSETS || 'none'}; responseBackend=${RESPONSE_BACKEND}; codexModel=${CODEX_MODEL}; autoFollow=${AUTO_FOLLOW}; endSilenceMs=${END_SILENCE_MS}; textContextMaxMessages=${TEXT_CONTEXT_MAX_MESSAGES}; daveEncryption=${DAVE_ENCRYPTION}; decryptionFailureTolerance=${DECRYPTION_FAILURE_TOLERANCE}`);
  await Promise.allSettled(client.guilds.cache.map((guild) => guild.commands.set(buildVoiceCommands())));
  console.log(`Registered slash commands: ${buildVoiceCommands().map((command) => `/${command.name}`).join(', ')}`);
});

process.on('SIGINT', () => client.destroy().finally(() => process.exit(0)));
process.on('SIGTERM', () => client.destroy().finally(() => process.exit(0)));

await client.login(DISCORD_TOKEN);
