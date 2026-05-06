import fs from 'node:fs';
import path from 'node:path';

import { formatTextContextForPrompt } from './context.js';

export function loadSoulPersona({ hermesHome = process.env.HERMES_HOME || '/root/.hermes' } = {}) {
  const soulPath = path.join(hermesHome, 'SOUL.md');
  try {
    return fs.readFileSync(soulPath, 'utf8').trim();
  } catch (err) {
    if (err?.code === 'ENOENT') return '';
    throw err;
  }
}

export function buildVoicePrompt({ state, transcript, username, soulPersona = loadSoulPersona(), includeSoulPersona = true }) {
  const history = (state.history || [])
    .slice(-8)
    .map((turn) => `${turn.role}: ${turn.text}`)
    .join('\n');
  const textContext = formatTextContextForPrompt(state.textContext, {
    maxMessageChars: state.textContext?.explicit ? 650 : 280,
  });
  const privateContext = state.privateContext?.content;
  return [
    includeSoulPersona && soulPersona ? `Hermes SOUL.md persona and operating rules, shared with normal text Hermes:\n${soulPersona}` : '',
    'This is the Discord voice transport for Hermes. Follow the same persona, style, and operating rules as normal text Hermes; do not adopt a separate voice-assistant personality.',
    'You are the live assistant, not the engineer debugging this bridge; never mention voice connection/TTS/internal pipeline problems unless explicitly asked.',
    state.textContext?.explicit ? `The user explicitly handed off this Discord thread/topic: "${state.textContext.topic || state.textContext.sourceLabel}". Treat that thread as the main working context and preserve continuity with it.` : '',
    privateContext ? `Private context you may use for this conversation (${state.privateContext.source}):\n${privateContext}` : '',
    textContext ? `Use this recent Discord text context when relevant:\n${textContext}` : '',
    history ? `Recent voice conversation:\n${history}` : '',
    `Speaker: ${username}`,
    `User said: ${transcript}`,
  ].filter(Boolean).join('\n');
}
