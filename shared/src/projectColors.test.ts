import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allocateProjectColor, PROJECT_COLORS, projectColorSchema } from './api.js';
describe('persisted project palette', () => {
  it('has light/dark web tokens for every palette key', () => {
    const css = readFileSync(new URL('../../web/src/styles/app.css', import.meta.url), 'utf8') + readFileSync(new URL('../../web/src/styles/tokens.css', import.meta.url), 'utf8');
    for (const key of PROJECT_COLORS) expect(css.match(new RegExp(`--g-${key} *:`, 'g'))?.length).toBeGreaterThanOrEqual(2);
  });
  it('has twelve valid distinct colors and deterministic least-used allocation', () => {
    expect(new Set(PROJECT_COLORS).size).toBeGreaterThanOrEqual(12);
    expect(allocateProjectColor([])).toBe(PROJECT_COLORS[0]);
    expect(allocateProjectColor([...PROJECT_COLORS])).toBe(PROJECT_COLORS[0]);
    const used = [...PROJECT_COLORS, PROJECT_COLORS[0]];
    expect(allocateProjectColor(used)).toBe(PROJECT_COLORS[1]);
    expect(allocateProjectColor([...used].reverse())).toBe(PROJECT_COLORS[1]);
    for (const color of PROJECT_COLORS) expect(projectColorSchema.safeParse(color).success).toBe(true);
    expect(allocateProjectColor(used, 'project-id')).toBe(allocateProjectColor([...used].reverse(), 'project-id'));
    expect(projectColorSchema.safeParse('#ffffff').success).toBe(false);
  });
});

// CIELAB D65 / CIE76: >=20 is a deliberately conservative separation gate for small markers.
const rgb = (hex: string) => [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
function lab(hex: string): number[] {
  const [r, g, b] = rgb(hex).map(linear) as [number, number, number];
  const xyz = [(r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047, r * 0.2126729 + g * 0.7151522 + b * 0.072175, (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883];
  const f = xyz.map(v => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116)) as [number, number, number];
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}
const delta = (a: string, b: string) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]!));
const luminance = (hex: string) =>
  rgb(hex)
    .map(linear)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
it('keeps every pair at DeltaE76 >=20 and marker contrast >=3:1 in both themes', () => {
  const css = readFileSync(new URL('../../web/src/styles/tokens.css', import.meta.url), 'utf8');
  for (const theme of css.split(':root[data-theme="light"]')) {
    const values = Object.fromEntries([...theme.matchAll(/--([\w-]+):\s*#([a-f0-9]{6})/g)].map(match => [match[1]!, match[2]!]));
    for (const [i, a] of PROJECT_COLORS.entries()) {
      for (const b of PROJECT_COLORS.slice(i + 1)) expect(delta(values[`g-${a}`]!, values[`g-${b}`]!), `${a}/${b}`).toBeGreaterThanOrEqual(20);
      for (const bg of ['bg', 'side', 'surface']) {
        const light = [luminance(values[`g-${a}`]!), luminance(values[bg]!)].sort((x, y) => x - y);
        expect((light[1]! + 0.05) / (light[0]! + 0.05), `${a}/${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
    expect(delta(values['g-none']!, values['g-slate']!)).toBeGreaterThanOrEqual(20);
  }
});
