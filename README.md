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
| `VOICE_TTS_MODEL` | `gpt-4o-mini-tts` | OpenAI speech model |
| `VOICE_TTS_VOICE` | `alloy` | OpenAI TTS voice |
| `VOICE_RESPONSE_BACKEND` | `hermes` | `hermes` or `codex` |
| `VOICE_HERMES_PROVIDER` | `openai-codex` | Hermes provider override |
| `VOICE_HERMES_MODEL` | `gpt-5.1-codex-mini` | Hermes model override |
| `VOICE_AUTO_FOLLOW` | `true` | Auto-join allowed users' voice channels |

See `.env.example` for the full list.

## Cost notes

With the default setup, the paid API calls are just speech in/out:

- STT: `gpt-4o-mini-transcribe`, roughly $0.003/min of user speech
- TTS: `gpt-4o-mini-tts`, roughly $0.015/min of generated Hermes speech
- Brain: can be routed through Hermes/Codex OAuth instead of OpenAI API billing

## Safety

Do not commit `.env` or tokens. This repo includes `.gitignore` and `.env.example` so secrets stay local.
