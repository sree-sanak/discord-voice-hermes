import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
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

// Load a local .env first, then the main Hermes env file when run alongside Hermes.
const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
dotenvConfig({ path: path.join(process.cwd(), '.env'), override: false, quiet: true });
dotenvConfig({ path: path.join(hermesHome, '.env'), override: false, quiet: true });

const execFileAsync = promisify(execFile);

const DISCORD_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
const OPENAI_KEY = process.env.VOICE_TOOLS_OPENAI_KEY || process.env.OPENAI_API_KEY;
const PREFIX = process.env.VOICE_COMMAND_PREFIX || '!voice';
const STT_MODEL = process.env.VOICE_STT_MODEL || 'gpt-4o-mini-transcribe';
const TTS_MODEL = process.env.VOICE_TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.VOICE_TTS_VOICE || 'alloy';
const MIN_AUDIO_MS = Number(process.env.VOICE_MIN_AUDIO_MS || 300);
const END_SILENCE_MS = Number(process.env.VOICE_END_SILENCE_MS || 450);
const HERMES_BIN = process.env.VOICE_HERMES_BIN || 'hermes';
const HERMES_SESSION_PREFIX = process.env.VOICE_HERMES_SESSION || 'discord-voice';
const HERMES_PROVIDER = process.env.VOICE_HERMES_PROVIDER || 'openai-codex';
const HERMES_MODEL = process.env.VOICE_HERMES_MODEL || 'gpt-5.1-codex-mini';
const RESPONSE_BACKEND = (process.env.VOICE_RESPONSE_BACKEND || 'hermes').toLowerCase();
const HERMES_TOOLSETS = process.env.VOICE_HERMES_TOOLSETS || '';
const MAX_HERMES_MS = Number(process.env.VOICE_HERMES_TIMEOUT_MS || 25000);
const CODEX_BIN = process.env.VOICE_CODEX_BIN || 'codex';
const CODEX_HOME = process.env.VOICE_CODEX_HOME || '/var/lib/hermes-codex';
const CODEX_MODEL = process.env.VOICE_CODEX_MODEL || 'gpt-5.1-codex-mini';
const MAX_CODEX_MS = Number(process.env.VOICE_CODEX_TIMEOUT_MS || 60000);
const AUTO_FOLLOW = !['0', 'false', 'no'].includes(String(process.env.VOICE_AUTO_FOLLOW || 'true').toLowerCase());
const IGNORE_AFTER_PLAYBACK_MS = Number(process.env.VOICE_IGNORE_AFTER_PLAYBACK_MS || 1200);

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
  return [
    'You are Hermes speaking in a Discord voice channel. Reply conversationally and briefly, optimized for TTS.',
    'Avoid markdown tables/code unless explicitly requested. Keep most replies under 5 sentences.',
    history ? `Recent conversation:\n${history}` : '',
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
  return message.reply(`Joined **${voiceChannel.name}**. Speak normally; I will respond after ~${END_SILENCE_MS}ms of silence.`);
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
    `stt: ${STT_MODEL}`,
    `tts: ${TTS_MODEL}/${TTS_VOICE}`,
    `autoFollow: ${AUTO_FOLLOW}`,
    `ignoreAfterPlaybackMs: ${IGNORE_AFTER_PLAYBACK_MS}`,
    `responseBackend: ${RESPONSE_BACKEND}`,
    `codexModel: ${CODEX_MODEL}`,
    `hermesSessionId: ${state.hermesSessionId || 'not started'}`,
    `lastTranscript: ${state.lastTranscript || 'none'}`,
  ].join('\n'));
}

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;
  const arg = message.content.slice(PREFIX.length).trim().toLowerCase();
  try {
    if (arg === 'join') return await join(message);
    if (arg === 'leave') return await leave(message);
    if (arg === 'status' || arg === '') return await status(message);
    return message.reply(`Commands: \`${PREFIX} join\`, \`${PREFIX} leave\`, \`${PREFIX} status\``);
  } catch (err) {
    console.error('[command]', err);
    return message.reply(`Voice command failed: ${err.message}`);
  }
});

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
      await state.textChannel?.send(`🔊 Auto-joined **${newState.channel.name}**.`).catch(() => {});
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

client.once('clientReady', () => {
  console.log(`Discord Voice Hermes ready as ${client.user.tag}`);
  console.log(`Prefix: ${PREFIX}; allowed users: ${allowedUsers.size || 'any'}; STT=${STT_MODEL}; TTS=${TTS_MODEL}/${TTS_VOICE}; Hermes=${HERMES_PROVIDER}/${HERMES_MODEL}; toolsets=${HERMES_TOOLSETS || 'none'}; responseBackend=${RESPONSE_BACKEND}; codexModel=${CODEX_MODEL}; autoFollow=${AUTO_FOLLOW}`);
});

process.on('SIGINT', () => client.destroy().finally(() => process.exit(0)));
process.on('SIGTERM', () => client.destroy().finally(() => process.exit(0)));

await client.login(DISCORD_TOKEN);
