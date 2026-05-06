import test from 'node:test';
import assert from 'node:assert/strict';

import { formatLatencySummary } from '../src/voice-latency.js';

test('formatLatencySummary reports stage and total durations compactly', () => {
  const summary = formatLatencySummary({
    recordMs: 1100,
    sttMs: 420,
    contextMs: 30,
    assistantMs: 14000,
    ttsMs: 700,
    playbackMs: 2200,
  });

  assert.equal(summary, 'total=18.45s record=1.10s stt=0.42s context=0.03s assistant=14.00s tts=0.70s playback=2.20s');
});

test('formatLatencySummary omits missing stages', () => {
  assert.equal(formatLatencySummary({ assistantMs: 1234 }), 'total=1.23s assistant=1.23s');
});
