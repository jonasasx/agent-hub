import { describe, expect, it } from 'vitest';
import { desktopExchangeRequestSchema, parseUiClientKind } from './desktop.js';

describe('parseUiClientKind', () => {
  it.each([
    ['desktop', 'desktop'],
    ['web', 'web'],
    ['x', 'web'],
    ['Desktop', 'web'],
    ['', 'web'],
    [null, 'web'],
    [undefined, 'web'],
  ] as const)('%s → %s', (value, kind) => {
    expect(parseUiClientKind(value)).toBe(kind);
  });
});

describe('desktopExchangeRequestSchema', () => {
  const ok = { code: 'c'.repeat(43), codeVerifier: 'v'.repeat(43), state: 's'.repeat(22) };
  it('accepts a well-formed body', () => {
    expect(desktopExchangeRequestSchema.safeParse(ok).success).toBe(true);
    expect(desktopExchangeRequestSchema.safeParse({ ...ok, codeVerifier: 'a-._~'.repeat(25).slice(0, 128) }).success).toBe(true);
  });
  it.each([
    ['short verifier', { ...ok, codeVerifier: 'v'.repeat(42) }],
    ['long verifier', { ...ok, codeVerifier: 'v'.repeat(129) }],
    ['verifier with +', { ...ok, codeVerifier: `${'v'.repeat(42)}+` }],
    ['short state', { ...ok, state: 's'.repeat(21) }],
    ['empty code', { ...ok, code: '' }],
    ['missing state', { code: ok.code, codeVerifier: ok.codeVerifier }],
  ])('rejects %s', (_name, body) => {
    expect(desktopExchangeRequestSchema.safeParse(body).success).toBe(false);
  });
});
