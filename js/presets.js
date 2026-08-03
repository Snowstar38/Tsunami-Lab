// Shareable presets for Tsunami Lab. To publish a preset: click Export in the app,
// then paste the copied JSON object into this array (comma-separated).
window.TS = window.TS || {};
TS.presets = [
  {
    name: 'Ria coast — 12 m N-wave',
    settings: {
      seed: 42, coastComplexity: 1, hilliness: 0.9, barrierIslands: true,
      riverValley: true, N: 1024, waveAmplitude: 12, wavePeriod: 240,
      waveform: 'nwave', waveTrough: 0.6, manning: 0.03
    }
  }
];
