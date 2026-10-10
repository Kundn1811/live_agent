// Scene colours. Same shape as `Theme['scene']` in the portfolio's src/theme.ts, so
// when this is embedded there it can be handed the active theme's `scene` directly.
// Default = the portfolio's "Warm graphite" theme.

export const DEFAULT_SCENE = {
  keyLight: '#f5a524',
  fillLight: '#ef7b5a',
  shell: '#ef7b5a',
  lines: '#f2c46d',
  nodeA: '#f5a524',
  nodeB: '#ef7b5a',
  stars: '#9c958b',
  drones: {
    lights: [
      [1, 0.97, 0.92],
      [1, 0.97, 0.92],
      [1, 0.94, 0.84],
      [1, 0.89, 0.72],
      [0.98, 0.76, 0.42],
      [0.96, 0.65, 0.14],
    ],
    shadow: [0.42, 0.18, 0.1],
    rim: [0.72, 0.42, 0.1],
  },
};
