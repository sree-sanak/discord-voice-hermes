function seconds(ms) {
  return `${(Number(ms || 0) / 1000).toFixed(2)}s`;
}

export function formatLatencySummary(stages = {}) {
  const entries = [
    ['record', stages.recordMs],
    ['stt', stages.sttMs],
    ['context', stages.contextMs],
    ['assistant', stages.assistantMs],
    ['tts', stages.ttsMs],
    ['playback', stages.playbackMs],
  ].filter(([, value]) => Number.isFinite(value));
  const total = entries.reduce((sum, [, value]) => sum + Number(value), 0);
  return [
    `total=${seconds(total)}`,
    ...entries.map(([name, value]) => `${name}=${seconds(value)}`),
  ].join(' ');
}
