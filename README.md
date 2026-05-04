# Discord Voice Hermes

A lightweight Discord voice-channel bridge for [Hermes Agent](https://github.com/sree7k/hermes).

It lets you talk to Hermes in a normal Discord voice channel:

1. Listen to Discord voice audio.
2. Transcribe speech with OpenAI speech-to-text.
3. Send the transcript to Hermes, optionally using Codex/ChatGPT OAuth as the assistant brain.
4. Convert Hermes' reply to speech with OpenAI text-to-speech.
5. Play the reply back into the same voice channel.

## Features

- Discord text commands: `!voice join`, `!voice leave`, `!voice status`
- Optional auto-follow: bot joins/leaves when allowed users enter/leave voice channels
- User allowlist via Discord user IDs
- Persistent short conversation history for natural voice turns
- Hermes CLI backend by default, with optional direct Codex CLI backend
- Keeps API spend low: OpenAI API is used only for STT/TTS when Hermes/Codex handles reasoning

## Requirements

- Node.js 20+
- A Discord bot token with these bot intents enabled:
  - Guilds
  - Guild Messages
  - Message Content
  - Guild Voice States
- An OpenAI API key for STT/TTS
- Hermes CLI installed and authenticated, if using `VOICE_RESPONSE_BACKEND=hermes`
- Codex CLI authenticated, if using `VOICE_RESPONSE_BACKEND=codex`

## Setup

```bash
git clone https://github.com/zalatar242/discord-voice-hermes.git
cd discord-voice-hermes
npm install
cp .env.example .env
$EDITOR .env
npm start
```

Invite your Discord bot to a server with permission to read/send messages and connect/speak in voice channels. Then join a voice channel and run:

```text
!voice join
```

Or use `/voice-handoff` from a text channel to join or create a voice channel in that category and lock that text channel as the transcript/context room.

Slash commands:

| Command | Purpose |
| --- | --- |
| `/voice-handoff` | Use the current text channel as explicit context/transcript and join the best voice channel for that category. If none exists, create `voice-chat`. |
| `/voice-defaults` | Create one default `voice-chat` channel in every category that does not already have a voice channel. Requires the bot to have `Manage Channels`. |

## Configuration

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `DISCORD_VOICE_BOT_TOKEN` or `DISCORD_BOT_TOKEN` | Discord bot token |
| `VOICE_TOOLS_OPENAI_KEY` or `OPENAI_API_KEY` | OpenAI API key for STT/TTS |

Useful optional variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_VOICE_ALLOWED_USERS` | empty | Comma-separated Discord user IDs allowed to use voice |
| `VOICE_COMMAND_PREFIX` | `!voice` | Text command prefix |
| `VOICE_STT_MODEL` | `gpt-4o-mini-transcribe` | OpenAI transcription model |
| `VOICE_TTS_MODEL` | `tts-1` | OpenAI speech model; `tts-1` is much lower latency than `gpt-4o-mini-tts` for live voice chat |
| `VOICE_TTS_VOICE` | `alloy` | OpenAI TTS voice |
| `VOICE_FAST_MODE` | `true` in `.env.example`, off unless set | Lower-latency profile: shorter silence cutoff, less injected context, shorter Hermes timeout |
| `VOICE_MIN_AUDIO_MS` | `300`, or `200` with fast mode | Ignore shorter audio clips as noise |
| `VOICE_END_SILENCE_MS` | `450`, or `275` with fast mode | Silence needed before Hermes responds |
| `VOICE_DAVE_ENCRYPTION` | `false` | Disable Discord DAVE E2EE for receive stability; set `true` if Discord voice handshake stalls on DAVE-required channels |
| `VOICE_DEBUG` | `false` | Emit verbose @discordjs/voice handshake logs for diagnosing stuck joins |
| `VOICE_DECRYPTION_FAILURE_TOLERANCE` | `1000` | Extra tolerance for transient Discord voice decrypt failures |
| `VOICE_JOIN_ATTEMPTS` | `3` | Retry Discord voice handshakes before surfacing a join failure |
| `VOICE_RESPONSE_BACKEND` | `hermes` | `openai` for lowest-latency voice chat, or `hermes`/`codex` for full agent backends |
| `VOICE_OPENAI_MODEL` | `gpt-4o-mini` | Direct OpenAI response model when `VOICE_RESPONSE_BACKEND=openai` |
| `VOICE_HERMES_PROVIDER` | `openai-codex` | Hermes provider override |
| `VOICE_HERMES_MODEL` | `gpt-5.5` | Hermes model override |
| `VOICE_AUTO_FOLLOW` | `true` | Auto-join allowed users' voice channels |
| `VOICE_AUTO_TEXT_CONTEXT` | `true` | Auto-sync recent readable Discord text context when joining voice |
| `VOICE_DEFAULT_CHANNEL_NAME` | `voice-chat` | Name used when creating default category voice channels |
| `VOICE_TEXT_CONTEXT_FETCH_LIMIT` | `80`, or `30` with fast mode | Messages to fetch per candidate text channel |
| `VOICE_TEXT_CONTEXT_MAX_MESSAGES` | `24`, or `8` with fast mode | Messages injected into the voice prompt |
| `VOICE_TEXT_CONTEXT_MAX_AGE_MS` | `21600000` | Max context age, default 6 hours |

See `.env.example` for the full list.

## Automatic Discord text context

When an allowed user joins a voice channel, the bot tries to infer the text conversation you are continuing from without requiring commands:

1. It first reads recent messages from text channels in the same Discord category as the voice channel.
2. It scores channels higher when they contain recent messages from you or allowed users.
3. It falls back to your most recently active readable channel if the voice category has no useful text.
4. It injects a compact `Relevant Discord text context` block into the Hermes voice prompt.

The bot can only use channels where it has `View Channel` and `Read Message History` permissions.

## Cost notes

With the default setup, the paid API calls are just speech in/out:

- STT: `gpt-4o-mini-transcribe`, roughly $0.003/min of user speech
- TTS: `gpt-4o-mini-tts`, roughly $0.015/min of generated Hermes speech
- Brain: can be routed through Hermes/Codex OAuth instead of OpenAI API billing

## Safety

Do not commit `.env` or tokens. This repo includes `.gitignore` and `.env.example` so secrets stay local.
