import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildVoicePrompt, loadSoulPersona } from '../src/voice-prompt.js';

function tmpHermesHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-prompt-'));
}

test('loadSoulPersona reads the same SOUL.md used by text Hermes', () => {
  const home = tmpHermesHome();
  fs.writeFileSync(path.join(home, 'SOUL.md'), 'Text Hermes persona rule: be direct and avoid em dashes.\n');

  assert.equal(loadSoulPersona({ hermesHome: home }), 'Text Hermes persona rule: be direct and avoid em dashes.');
});

test('buildVoicePrompt includes SOUL.md for non-Hermes backends and does not add voice-specific brevity caps', () => {
  const prompt = buildVoicePrompt({
    state: { history: [], textContext: null, privateContext: null },
    transcript: 'Help me think through this.',
    username: 'Sree',
    soulPersona: 'Text Hermes persona rule: be direct and avoid em dashes.',
  });

  assert.match(prompt, /Text Hermes persona rule: be direct and avoid em dashes/);
  assert.match(prompt, /follow the same persona, style, and operating rules as normal text Hermes/i);
  assert.doesNotMatch(prompt, /1-2 spoken sentences|max 3|very short/i);
});

test('buildVoicePrompt avoids duplicating SOUL.md when Hermes CLI already loads it', () => {
  const prompt = buildVoicePrompt({
    state: { history: [], textContext: null, privateContext: null },
    transcript: 'Help me think through this.',
    username: 'Sree',
    soulPersona: 'Text Hermes persona rule: be direct and avoid em dashes.',
    includeSoulPersona: false,
  });

  assert.doesNotMatch(prompt, /Text Hermes persona rule: be direct and avoid em dashes/);
  assert.match(prompt, /follow the same persona, style, and operating rules as normal text Hermes/i);
  assert.doesNotMatch(prompt, /1-2 spoken sentences|max 3|very short/i);
});
