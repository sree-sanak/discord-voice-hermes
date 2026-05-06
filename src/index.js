import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { ChannelType, Client, GatewayIntentBits, Partials, PermissionsBitField } from 'discord.js';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
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
import { execFile, spawn } from 'node:child_process';
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
  formatVoiceJoinError,
  shouldDestroyVoiceConnection,
  shouldKeepPendingVoiceConnection,
  shouldRetryVoiceJoin,
  shouldReuseVoiceConnection,
  shouldReplaceStaleVoiceConnection,
  shouldDeferAutoLeave,
  summarizeVoiceOutputDiagnostics,
  voiceJoinRetryDelayMs,
} from './voice-connection.js';
import {
  DEFAULT_VOICE_CHANNEL_NAME,
  buildVoiceCommands,
  categoryVoiceDefaultsPlan,
  chooseVoiceChannelForHandoff,
  shouldConnectImmediatelyForHandoff,
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
const OPENAI_MODEL = config.openaiModel;
const HERMES_TOOLSETS = config.hermesToolsets;
const MAX_HERMES_MS = config.hermesTimeoutMs;
const CODEX_BIN = config.codexBin;
const CODEX_HOME = config.codexHome;
const CODEX_MODEL = config.codexModel;
const MAX_CODEX_MS = config.codexTimeoutMs;
const DAVE_ENCRYPTION = config.daveEncryption;
const VOICE_DEBUG = config.voiceDebug;
const DECRYPTION_FAILURE_TOLERANCE = config.decryptionFailureTolerance;
const VOICE_JOIN_ATTEMPTS = config.voiceJoinAttempts;
const AUTO_FOLLOW = config.autoFollow;
const IGNORE_AFTER_PLAYBACK_MS = config.ignoreAfterPlaybackMs;
const AUTO_TEXT_CONTEXT = config.autoTextContext;
const TEXT_CONTEXT_MAX_MESSAGES = config.textContextMaxMessages;
const TEXT_CONTEXT_FETCH_LIMIT = config.textContextFetchLimit;
const HANDOFF_CONTEXT_MAX_MESSAGES = config.handoffContextMaxMessages;
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
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    const state = {
      guildId,
      connection: null,
      player,
      textChannel: null,
      hermesSessionId: null,
      busy: false,
      playing: false,
      queued: [],
      recordingUsers: new Set(),
      lastTranscript: '',
      startedAt: Date.now(),
      receiverAttached: false,
      ignoredUntil: 0,
      history: [],
      textContext: null,
      explicitTextContextChannelId: null,
      privateContext: null,
      connecting: null,
      connectingChannelId: null,
      subscription: null,
      pendingAutoLeave: false,
    };
    player.on('stateChange', (oldState, newState) => {
      console.log(`[audio-player] ${oldState.status} -> ${newState.status}`);
    });
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
  if (state.explicitTextContextChannelId) return state.textContext;
  state.textContext = await fetchRecentTextContext(guild, voiceChannel, userId);
  if (!state.textChannel && state.textContext?.messages?.length) {
    const channelId = state.textContext.messages.at(-1)?.channelId;
    const channel = channelId ? guild.channels.cache.get(channelId) : null;
    if (canReadTextChannel(channel)) state.textChannel = channel;
  }
  return state.textContext;
}

async function setExplicitTextContextFromChannel(state, channel) {
  if (!canReadTextChannel(channel)) return null;
  state.explicitTextContextChannelId = channel.id;
  const fetchLimit = Math.max(TEXT_CONTEXT_FETCH_LIMIT, HANDOFF_CONTEXT_MAX_MESSAGES);
  const messages = await channel.messages.fetch({ limit: Math.min(fetchLimit, 100) });
  for (const message of messages.values()) rememberDiscordMessage(message);
  const selected = textContextCache.messages
    .filter((message) => message.guildId === channel.guild?.id)
    .filter((message) => message.channelId === channel.id)
    .filter((message) => Date.now() - message.createdTimestamp <= TEXT_CONTEXT_MAX_AGE_MS)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(-HANDOFF_CONTEXT_MAX_MESSAGES);
  state.textContext = selected.length ? {
    sourceLabel: `#${channel.name}`,
    topic: channel.name,
    explicit: true,
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
  const memberVoiceChannelId = member?.voice?.channelId;
  const decision = chooseVoiceChannelForHandoff({
    channels: guild.channels.cache,
    textChannel,
    memberVoiceChannelId,
    defaultVoiceChannelName: DEFAULT_VOICE_CHANNEL,
  });
  if (decision.action === 'join') {
    return {
      channel: decision.channel,
      created: false,
      reason: decision.reason,
      connectImmediately: shouldConnectImmediatelyForHandoff(decision, memberVoiceChannelId),
    };
  }
  if (decision.action === 'create') {
    const channel = await createDefaultVoiceChannel(guild, decision.parentId);
    return { channel, created: true, reason: decision.reason, connectImmediately: false };
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

function isCorruptOpusPacketError(err) {
  return /compressed data passed is corrupted/i.test(err?.message || '');
}

class TolerantOpusDecoder extends prism.opus.Decoder {
  constructor(options) {
    super(options);
    this.skippedPackets = 0;
  }

  _transform(chunk, encoding, done) {
    super._transform(chunk, encoding, (err) => {
      if (isCorruptOpusPacketError(err)) {
        this.skippedPackets += 1;
        return done();
      }
      return done(err);
    });
  }
}

async function recordUtterance(connection, userId) {
  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: END_SILENCE_MS },
  });
  const decoder = new TolerantOpusDecoder({ rate: 48000, channels: 2, frameSize: 960 });
  const chunks = [];
  decoder.on('data', (chunk) => chunks.push(chunk));
  await pipeline(opusStream, decoder).catch((err) => {
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err;
  });
  if (decoder.skippedPackets > 0) {
    console.warn(`[voice capture] skipped ${decoder.skippedPackets} corrupt opus packet(s)`);
  }
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

const PRIVATE_BRAIN_PROJECT_PATH = '/root/.hermes/private/brain/projects/mintara-eu-casp-mica-insurance.md';
const PRIVATE_CONTEXT_RE = /\b(yc|y combinator|application|apply|mintara|mica|casp|insurance|article\s*67|prudential|broker|elmore|regulator|nca|quote|premium)\b/i;

function shouldLoadPrivateContext(state, transcript) {
  const recent = [
    transcript,
    state.history.slice(-6).map((turn) => turn.text).join(' '),
    state.textContext?.messages?.slice(-8).map((message) => message.content).join(' '),
  ].filter(Boolean).join(' ');
  return PRIVATE_CONTEXT_RE.test(recent);
}

function compactPrivateBrainNote(markdown) {
  const lines = markdown
    .replace(/^---[\s\S]*?---\s*/m, '')
    .split(/\r?\n/);
  const keepSections = new Set([
    '# Mintara — EU CASP MiCA Insurance Strategy',
    '## Current thesis',
    '## Positioning',
    '## Best buyer profile',
    '## Current broker/channel state',
    '## Indicative premium bands captured',
    '## Active / notable prospect pipeline',
    '## Core unresolved risks',
    '## Near-term operating priorities',
  ]);
  const kept = [];
  let include = false;
  for (const line of lines) {
    if (line.startsWith('#')) include = keepSections.has(line.trim());
    if (include) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 7000);
}

async function refreshPrivateContextForVoice(state, transcript) {
  if (!shouldLoadPrivateContext(state, transcript)) return state.privateContext;
  if (state.privateContext && Date.now() - state.privateContext.fetchedAt < 15 * 60 * 1000) return state.privateContext;
  try {
    const markdown = fs.readFileSync(PRIVATE_BRAIN_PROJECT_PATH, 'utf8');
    state.privateContext = {
      source: 'private brain: Mintara EU CASP MiCA insurance strategy',
      fetchedAt: Date.now(),
      content: compactPrivateBrainNote(markdown),
    };
    console.log(`[private-context] loaded ${state.privateContext.content.length} chars from Mintara strategy note`);
  } catch (err) {
    console.warn(`[private-context] unavailable: ${err.message}`);
  }
  return state.privateContext;
}

function buildVoicePrompt(state, transcript, username) {
  const history = state.history
    .slice(-8)
    .map((turn) => `${turn.role}: ${turn.text}`)
    .join('\n');
  const textContext = formatTextContextForPrompt(state.textContext, {
    maxMessageChars: state.textContext?.explicit ? 650 : 280,
  });
  const privateContext = state.privateContext?.content;
  return [
    'You are Hermes speaking in a Discord voice channel. Be a useful founder/advisor, not a generic chatbot.',
    'You are the live assistant, not the engineer debugging this bridge; never mention voice connection/TTS/internal pipeline problems unless explicitly asked.',
    'For startup, YC, application, drafting, or strategy work: give a concrete recommended answer first, then ask at most one sharp follow-up question. Do not ask the user to repeat facts you likely have in context.',
    state.textContext?.explicit ? `The user explicitly handed off this Discord thread/topic: "${state.textContext.topic || state.textContext.sourceLabel}". Treat that thread as the main working context and preserve continuity with it.` : '',
    'If the user says "you know this" or asks you to fetch/use context, use the supplied private/text context and make a best-effort draft. State uncertainty briefly only if needed.',
    'Avoid markdown tables/code unless explicitly requested. Keep voice replies concise, but allow 3-5 sentences when drafting or advising.',
    privateContext ? `Private context you may use for this conversation (${state.privateContext.source}):\n${privateContext}` : '',
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
  // Voice replies should be fast and conversational. Disable Hermes tools by default
  // unless explicitly configured, otherwise startup/tool schema loading can exceed
  // the voice timeout and produce silence after transcription.
  args.push('-t', HERMES_TOOLSETS || '');
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

async function runCodex(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const maxBuffer = options.maxBuffer || 1024 * 1024 * 4;
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > maxBuffer) child.kill('SIGTERM');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`Command failed: ${CODEX_BIN} ${args.join(' ')}`);
      err.code = code;
      err.signal = signal;
      err.killed = signal === 'SIGTERM';
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function askCodex(state, transcript, username) {
  const prompt = buildVoicePrompt(state, transcript, username);
  const outPath = path.join(tmpRoot, `${Date.now()}-codex-response.txt`);
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-rules',
    '--sandbox', 'read-only',
    '--model', CODEX_MODEL,
    '--output-last-message', outPath,
    prompt,
  ];
  const { stderr } = await runCodex(args, {
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

async function askOpenAI(state, transcript, username) {
  const prompt = buildVoicePrompt(state, transcript, username);
  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 120,
    temperature: 0.6,
  });
  const text = response.choices?.[0]?.message?.content?.trim() || '';
  if (!text) throw new Error('OpenAI returned empty response');
  return text;
}

async function askAssistant(state, transcript, username) {
  if (RESPONSE_BACKEND === 'openai') return askOpenAI(state, transcript, username);
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
    response_format: 'mp3',
  });
  const audio = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outPath, audio);
  return outPath;
}

function packetsPlayed(connection) {
  return connection?.state?.networking?.state?.connectionData?.packetsPlayed ?? null;
}

function daveStatus(connection) {
  const dave = connection?.state?.networking?.state?.dave;
  const session = dave?.session;
  return {
    enabled: DAVE_ENCRYPTION,
    protocolVersion: dave?.protocolVersion,
    ready: !DAVE_ENCRYPTION || dave?.protocolVersion === 0 || Boolean(session?.ready),
    sessionStatus: session?.status,
    epoch: session?.epoch == null ? null : String(session.epoch),
  };
}

async function waitForDaveReady(connection, timeoutMs = 10000) {
  if (!DAVE_ENCRYPTION) return true;
  const started = Date.now();
  let lastLog = 0;
  while (Date.now() - started < timeoutMs) {
    const status = daveStatus(connection);
    if (status.ready) return true;
    if (Date.now() - lastLog > 2000) {
      console.log(`[pipeline] waiting for DAVE before playback protocol=${status.protocolVersion ?? 'unknown'} status=${status.sessionStatus ?? 'unknown'} epoch=${status.epoch ?? 'none'}`);
      lastLog = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const status = daveStatus(connection);
  console.warn(`[pipeline] skipped TTS playback: DAVE not ready protocol=${status.protocolVersion ?? 'unknown'} status=${status.sessionStatus ?? 'unknown'} epoch=${status.epoch ?? 'none'}`);
  return false;
}

function ensurePlayerSubscribed(state) {
  if (!state.connection || state.connection.state.status !== VoiceConnectionStatus.Ready) return false;
  if (state.subscription?.connection === state.connection) return true;
  state.subscription = state.connection.subscribe(state.player);
  return Boolean(state.subscription);
}

function voiceOutputDiagnostics(state) {
  const { guild, channel } = connectedChannelForState(state);
  const botMember = guild?.members?.me;
  const permissions = botMember && channel?.permissionsFor?.(botMember);
  const diagnostics = {
    channelId: channel?.id || null,
    channelName: channel?.name || null,
    botVoiceChannelId: botMember?.voice?.channelId || null,
    selfMute: Boolean(botMember?.voice?.selfMute),
    serverMute: Boolean(botMember?.voice?.serverMute),
    suppress: Boolean(botMember?.voice?.suppress),
    speakPermission: permissions ? permissions.has(PermissionsBitField.Flags.Speak) : null,
    subscribed: Boolean(state.subscription?.connection === state.connection),
  };
  diagnostics.blockers = summarizeVoiceOutputDiagnostics(diagnostics);
  return diagnostics;
}

function logVoiceOutputDiagnostics(state, label = 'pipeline') {
  const d = voiceOutputDiagnostics(state);
  console.log(`[${label}] voice output diagnostics channel=${d.channelName || d.channelId || 'unknown'} botVoiceChannel=${d.botVoiceChannelId || 'none'} selfMute=${d.selfMute} serverMute=${d.serverMute} suppress=${d.suppress} speakPermission=${d.speakPermission ?? 'unknown'} subscribed=${d.subscribed} blockers=${d.blockers.length ? d.blockers.join(',') : 'none'}`);
  return d;
}

function connectedChannelForState(state) {
  const guild = client.guilds.cache.get(state.guildId);
  const connection = getVoiceConnection(state.guildId) || state.connection;
  if (!guild || !connection) return { guild, connection, channel: null };
  return { guild, connection, channel: guild.channels.cache.get(connection.joinConfig?.channelId) || null };
}

function hasAllowedHumanInConnectedChannel(state) {
  const { channel } = connectedChannelForState(state);
  return Boolean(channel?.members?.some((member) => !member.user.bot && isAllowed(member.id)));
}

async function leaveIfNoAllowedHuman(state, reason = 'auto leave') {
  const { connection } = connectedChannelForState(state);
  if (!connection || hasAllowedHumanInConnectedChannel(state)) return false;
  safeDestroyVoiceConnection(connection, reason);
  state.connection = null;
  state.subscription = null;
  state.receiverAttached = false;
  state.pendingAutoLeave = false;
  await state.textChannel?.send('🔇 Auto-left voice channel.').catch(() => {});
  return true;
}

function scheduleAutoLeaveWhenIdle(state, delayMs = 5000) {
  if (state.pendingAutoLeave) return;
  state.pendingAutoLeave = true;
  setTimeout(async () => {
    if (shouldDeferAutoLeave(state)) {
      state.pendingAutoLeave = false;
      scheduleAutoLeaveWhenIdle(state, delayMs);
      return;
    }
    await leaveIfNoAllowedHuman(state, 'deferred auto leave');
  }, delayMs);
}

async function playFile(state, audioPath) {
  if (!state.connection || state.connection.state.status !== VoiceConnectionStatus.Ready) {
    console.warn(`[pipeline] skipped TTS playback: voice connection is ${state.connection?.state?.status || 'missing'}`);
    return false;
  }
  if (!hasAllowedHumanInConnectedChannel(state)) {
    console.warn('[pipeline] skipped TTS playback: no allowed human remains in voice channel');
    await leaveIfNoAllowedHuman(state, 'skip playback empty channel');
    return false;
  }
  if (!await waitForDaveReady(state.connection)) return false;
  if (!hasAllowedHumanInConnectedChannel(state)) {
    console.warn('[pipeline] skipped TTS playback: no allowed human remains in voice channel after DAVE wait');
    await leaveIfNoAllowedHuman(state, 'skip playback empty channel after DAVE wait');
    return false;
  }
  if (!ensurePlayerSubscribed(state)) throw new Error('Cannot play TTS: failed to subscribe audio player to voice connection');
  const diagnostics = logVoiceOutputDiagnostics(state);
  if (diagnostics.blockers.length) {
    console.warn(`[pipeline] voice output blockers before playback: ${diagnostics.blockers.join(',')}`);
  }

  // Last known audible path: decode TTS to 48kHz stereo raw PCM and let
  // @discordjs/voice handle Opus packetization/encryption. The OggOpus path can
  // report packets sent while Discord desktop clients hear silence.
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', audioPath,
    '-analyzeduration', '0',
    '-af', 'volume=2.2',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ffmpegErr = '';
  ffmpeg.stderr.on('data', (chunk) => { ffmpegErr += chunk.toString(); });
  ffmpeg.on('close', (code) => {
    if (code) console.warn(`[ffmpeg playback] exited ${code}: ${ffmpegErr.trim()}`);
  });

  const beforePackets = packetsPlayed(state.connection);
  console.log(`[pipeline] playing TTS via ffmpeg raw PCM ${path.basename(audioPath)} (${fs.statSync(audioPath).size} bytes); packetsBefore=${beforePackets ?? 'unknown'}`);
  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw, inlineVolume: true, metadata: { audioPath } });
  resource.volume?.setVolume(1.35);
  state.player.play(resource);
  await entersState(state.player, AudioPlayerStatus.Playing, 5000);
  await entersState(state.player, AudioPlayerStatus.Idle, 120000).catch(() => {});
  const afterPackets = packetsPlayed(state.connection);
  const delta = beforePackets == null || afterPackets == null ? 'unknown' : String(afterPackets - beforePackets);
  console.log(`[pipeline] TTS playback finished; packetsAfter=${afterPackets ?? 'unknown'} packetsDelta=${delta}`);
  return true;
}

async function playText(state, text, label = 'pipeline') {
  let ttsPath = null;
  try {
    console.log(`[${label}] synthesizing TTS...`);
    ttsPath = await synthesize(text);
    return await playFile(state, ttsPath);
  } finally {
    if (ttsPath) fs.rm(ttsPath, { force: true }, () => {});
  }
}


async function processTranscript(state, transcript, username) {
  if (state.busy) {
    state.queued.push({ transcript, username });
    state.queued = state.queued.slice(-3);
    console.log(`[pipeline] queued transcript while busy (${state.queued.length} pending)`);
    return;
  }
  state.busy = true;
  try {
    await refreshPrivateContextForVoice(state, transcript);
    console.log('[pipeline] asking Hermes...');
    const reply = await askAssistant(state, transcript, username);
    console.log(`[${RESPONSE_BACKEND}] ${reply}`);
    state.textChannel?.send(`🔊 **Hermes:** ${reply}`).catch((err) => console.warn('[discord send reply]', err.message));
    state.history.push({ role: username, text: transcript }, { role: 'Hermes', text: reply });
    state.history = state.history.slice(-12);

    await playText(state, reply, 'pipeline');
  } catch (err) {
    console.error('[voice pipeline]', err);
    await state.textChannel?.send(`⚠️ Voice pipeline error: ${err.message}`).catch(() => {});
  } finally {
    state.busy = false;
    await leaveIfNoAllowedHuman(state, 'pipeline idle auto leave');
    const next = state.queued.shift();
    if (next) setImmediate(() => processTranscript(state, next.transcript, next.username));
  }
}

async function handleSpeech(state, userId) {
  if (state.playing || !state.connection || Date.now() < state.ignoredUntil) return;
  if (state.recordingUsers.has(userId)) return;
  state.recordingUsers.add(userId);
  let wavPath = null;
  try {
    const user = await client.users.fetch(userId).catch(() => null);
    const username = user?.username || userId;
    const recorded = await recordUtterance(state.connection, userId);
    if (!recorded) {
      console.log(`[record] ignored short/empty utterance from ${username}`);
      return;
    }
    wavPath = recorded.wavPath;

    const transcript = await transcribe(wavPath);
    if (!transcript || transcript.length < 2) {
      console.log(`[stt] empty transcript for ${username} (${Math.round(recorded.duration)}ms audio)`);
      return;
    }
    if (/^(you|um|uh|hm|hmm|yeah|okay|ok|thanks?)\.?$/i.test(transcript.trim())) {
      console.log(`[stt] ignored filler transcript from ${username}: ${transcript}`);
      return;
    }
    state.lastTranscript = transcript;
    console.log(`[stt] ${username}: ${transcript}`);
    state.textChannel?.send(`🎙️ **${username}:** ${transcript}`).catch((err) => console.warn('[discord send transcript]', err.message));
    await processTranscript(state, transcript, username);
  } catch (err) {
    console.error('[voice capture]', err);
    await state.textChannel?.send(`⚠️ Voice capture error: ${err.message}`).catch(() => {});
  } finally {
    state.recordingUsers.delete(userId);
    if (wavPath) fs.rm(wavPath, { force: true }, () => {});
  }
}

function attachReceiver(state) {
  if (state.receiverAttached) return;
  state.receiverAttached = true;
  console.log('[receiver] attached speaking listener');
  state.connection.receiver.speaking.on('start', (userId) => {
    if (userId === client.user?.id) return;
    if (!isAllowed(userId)) return;
    console.log(`[receiver] speaking start user=${userId}`);
    handleSpeech(state, userId);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeDestroyVoiceConnection(connection, reason = 'cleanup') {
  if (!shouldDestroyVoiceConnection(connection)) return false;
  try {
    connection.destroy();
    return true;
  } catch (err) {
    if (/already been destroyed/i.test(err?.message || '')) return false;
    console.warn(`[voice connection] destroy failed during ${reason}: ${err?.message || err}`);
    return false;
  }
}

function registerVoiceConnection(state, connection, voiceChannel) {
  state.connection = connection;
  connection.on('stateChange', (oldState, newState) => {
    console.log(`[voice connection] ${voiceChannel.name}: ${oldState.status} -> ${newState.status}`);
    if (newState.status === VoiceConnectionStatus.Ready) attachReceiver(state);
    if (newState.status === VoiceConnectionStatus.Destroyed) {
      state.receiverAttached = false;
      state.subscription = null;
      if (state.connection === connection) state.connection = null;
    }
  });
  connection.on('debug', (message) => console.log(`[voice debug] ${voiceChannel.name}: ${message}`));
  connection.on('error', (err) => console.error(`[voice connection error] ${voiceChannel.name}:`, err));
  connection.on(VoiceConnectionStatus.Disconnected, () => {
    state.connection = null;
    state.receiverAttached = false;
    state.subscription = null;
  });
}

async function createReadyVoiceConnection(state, guild, voiceChannel, attempt) {
  console.log(`[voice join] attempt ${attempt}/${VOICE_JOIN_ATTEMPTS} target=${voiceChannel.name} id=${voiceChannel.id} joinable=${voiceChannel.joinable} speakable=${voiceChannel.speakable} full=${voiceChannel.full}`);
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
    daveEncryption: DAVE_ENCRYPTION,
    decryptionFailureTolerance: DECRYPTION_FAILURE_TOLERANCE,
    debug: VOICE_DEBUG,
  });
  registerVoiceConnection(state, connection, voiceChannel);
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30000);
    return { connection, ready: true };
  } catch (err) {
    if (shouldRetryVoiceJoin(err, attempt, VOICE_JOIN_ATTEMPTS)) {
      safeDestroyVoiceConnection(connection, `retry attempt ${attempt}`);
      const delayMs = voiceJoinRetryDelayMs(attempt);
      console.warn(`[voice join] attempt ${attempt}/${VOICE_JOIN_ATTEMPTS} timed out for ${voiceChannel.name}; retrying in ${delayMs}ms`);
      await sleep(delayMs);
      return null;
    }
    if (shouldKeepPendingVoiceConnection(err, attempt, VOICE_JOIN_ATTEMPTS)) {
      console.warn(`[voice join] attempt ${attempt}/${VOICE_JOIN_ATTEMPTS} timed out for ${voiceChannel.name}; keeping pending connection alive for late Ready`);
      return { connection, ready: false };
    }
    safeDestroyVoiceConnection(connection, 'failed join');
    throw err;
  }
}

async function connectToVoiceChannel(state, guild, voiceChannel) {
  if (state.connecting) {
    const activeTarget = state.connectingChannelId;
    console.log(`[voice join] already connecting to ${activeTarget}; waiting before handling ${voiceChannel.id}`);
    await state.connecting.catch(() => null);
    const afterWait = getVoiceConnection(guild.id) || state.connection;
    if (shouldReuseVoiceConnection(afterWait, guild.id, voiceChannel.id, VoiceConnectionStatus.Ready)) {
      state.connection = afterWait;
      attachReceiver(state);
      return { connection: afterWait, ready: true, reused: true };
    }
  }

  const run = (async () => {
    const existing = getVoiceConnection(guild.id) || state.connection;
    if (shouldReuseVoiceConnection(existing, guild.id, voiceChannel.id, VoiceConnectionStatus.Ready)) {
      state.connection = existing;
      attachReceiver(state);
      return { connection: existing, ready: true, reused: true };
    }
    if (shouldReplaceStaleVoiceConnection(existing, guild.id, voiceChannel.id, VoiceConnectionStatus.Ready)) {
      console.warn(`[voice join] replacing stale same-channel connection ${existing.state?.status || 'unknown'} for ${voiceChannel.name}`);
      safeDestroyVoiceConnection(existing, 'stale same-channel join');
    } else if (existing && existing.joinConfig?.channelId !== voiceChannel.id) {
      safeDestroyVoiceConnection(existing, 'switch channel');
    }

    state.receiverAttached = false;
    state.subscription = null;
    for (let attempt = 1; attempt <= VOICE_JOIN_ATTEMPTS; attempt += 1) {
      try {
        const result = await createReadyVoiceConnection(state, guild, voiceChannel, attempt);
        if (!result) continue;
        if (result.ready) attachReceiver(state);
        return result;
      } catch (err) {
        state.connection = null;
        state.subscription = null;
        state.receiverAttached = false;
        throw new Error(formatVoiceJoinError(err, voiceChannel.name, VOICE_JOIN_ATTEMPTS));
      }
    }
    throw new Error(formatVoiceJoinError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }), voiceChannel.name, VOICE_JOIN_ATTEMPTS));
  })();

  state.connecting = run;
  state.connectingChannelId = voiceChannel.id;
  try {
    return await run;
  } finally {
    if (state.connecting === run) {
      state.connecting = null;
      state.connectingChannelId = null;
    }
  }
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
  safeDestroyVoiceConnection(connection, 'manual leave');
  state.connection = null;
  state.subscription = null;
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
    `voiceDebug: ${VOICE_DEBUG}`,
    `decryptionFailureTolerance: ${DECRYPTION_FAILURE_TOLERANCE}`,
    `voiceJoinAttempts: ${VOICE_JOIN_ATTEMPTS}`,
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

  const { channel: voiceChannel, created, connectImmediately } = await resolveHandoffVoiceChannel(guild, textChannel, member);
  const context = await setExplicitTextContextFromChannel(state, textChannel).catch((err) => {
    console.warn('[explicit text context fetch]', err.message);
    return null;
  });
  const createdNote = created ? ` Created **${voiceChannel.name}** first.` : '';
  const contextNote = context ? ` Locked context/transcripts to #${textChannel.name}.` : ` I will mirror transcripts in #${textChannel.name}.`;
  if (!connectImmediately) {
    return `Voice handoff ready for **${voiceChannel.name}** from #${textChannel.name}.${createdNote}${contextNote} Join **${voiceChannel.name}** and I will auto-follow you there.`;
  }
  await connectToVoiceChannel(state, guild, voiceChannel);
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
  const targetVoiceChannel = newState.channel;
  const oldVoiceChannel = oldState.channel;
  console.log(`[voice state] user=${userId} old=${oldVoiceChannel?.name || 'none'} new=${targetVoiceChannel?.name || 'none'} connection=${connection?.state?.status || 'none'} channel=${connection?.joinConfig?.channelId || 'none'}`);

  try {
    if (targetVoiceChannel && (!connection || connection.joinConfig?.channelId !== targetVoiceChannel.id)) {
      await connectToVoiceChannel(state, guild, targetVoiceChannel);
      const context = await refreshTextContextForVoice(state, guild, targetVoiceChannel, userId).catch((err) => {
        console.warn('[text context fetch]', err.message);
        return null;
      });
      const contextNote = context?.explicit
        ? ` Using locked handoff context from ${context.sourceLabel} (${context.messages.length} messages).`
        : context ? ` Using recent text context from ${context.sourceLabel}.` : '';
      const statusNote = result?.ready ? 'Auto-joined' : 'Started joining';
      await state.textChannel?.send(`🔊 ${statusNote} **${targetVoiceChannel.name}**.${contextNote}`).catch(() => {});
      return;
    }

    if (!targetVoiceChannel && connection) {
      const connectedChannel = guild.channels.cache.get(connection.joinConfig?.channelId);
      const hasAllowedHuman = connectedChannel?.members?.some((member) => !member.user.bot && isAllowed(member.id));
      if (!hasAllowedHuman) {
        if (shouldDeferAutoLeave(state)) {
          console.log('[voice auto-follow] deferring auto-leave until playback/pipeline is idle');
          scheduleAutoLeaveWhenIdle(state);
          return;
        }
        await leaveIfNoAllowedHuman(state, 'auto leave');
      }
    }
  } catch (err) {
    console.error('[voice auto-follow]', err);
  }
});

async function registerCommands() {
  await Promise.allSettled(client.guilds.cache.map((guild) => guild.commands.set(buildVoiceCommands())));
  console.log(`Registered slash commands: ${buildVoiceCommands().map((command) => `/${command.name}`).join(', ')}`);
}

async function autoFollowExistingVoiceMembers() {
  if (!AUTO_FOLLOW) return;
  for (const guild of client.guilds.cache.values()) {
    const voiceStates = guild.voiceStates.cache.filter((voiceState) => {
      const member = voiceState.member;
      return voiceState.channel && member && !member.user?.bot && isAllowed(member.id);
    });
    for (const voiceState of voiceStates.values()) {
      const state = getSession(guild.id);
      const existing = getVoiceConnection(guild.id) || state.connection;
      if (existing?.joinConfig?.channelId === voiceState.channel.id) continue;
      try {
        const result = await connectToVoiceChannel(state, guild, voiceState.channel);
        const context = await refreshTextContextForVoice(state, guild, voiceState.channel, voiceState.id).catch((err) => {
          console.warn('[startup text context fetch]', err.message);
          return null;
        });
        const contextNote = context ? ` Using recent text context from ${context.sourceLabel}.` : '';
        const statusNote = result?.ready ? 'Auto-rejoined' : 'Started rejoining';
        await state.textChannel?.send(`🔊 ${statusNote} **${voiceState.channel.name}** after restart.${contextNote}`).catch(() => {});
      } catch (err) {
        console.error('[startup auto-follow]', err);
      }
    }
  }
}

client.once('clientReady', async () => {
  console.log(`Discord Voice Hermes ready as ${client.user.tag}`);
  console.log(`Prefix: ${PREFIX}; allowed users: ${allowedUsers.size || 'any'}; fastMode=${FAST_MODE}; STT=${STT_MODEL}; TTS=${TTS_MODEL}/${TTS_VOICE}; Hermes=${HERMES_PROVIDER}/${HERMES_MODEL}; toolsets=${HERMES_TOOLSETS || 'none'}; responseBackend=${RESPONSE_BACKEND}; openaiModel=${OPENAI_MODEL}; codexModel=${CODEX_MODEL}; autoFollow=${AUTO_FOLLOW}; endSilenceMs=${END_SILENCE_MS}; textContextMaxMessages=${TEXT_CONTEXT_MAX_MESSAGES}; daveEncryption=${DAVE_ENCRYPTION}; voiceDebug=${VOICE_DEBUG}; decryptionFailureTolerance=${DECRYPTION_FAILURE_TOLERANCE}; voiceJoinAttempts=${VOICE_JOIN_ATTEMPTS}`);
  await registerCommands().catch((err) => console.warn('[slash commands]', err.message));
  await autoFollowExistingVoiceMembers();
});

process.on('SIGINT', () => client.destroy().finally(() => process.exit(0)));
process.on('SIGTERM', () => client.destroy().finally(() => process.exit(0)));

await client.login(DISCORD_TOKEN);
