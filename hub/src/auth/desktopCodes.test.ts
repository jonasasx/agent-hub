// Task 1.2: DesktopCodeStore (Requirement: Одноразовый код входа).
import { describe, expect, it } from 'vitest';
import { DESKTOP_CODE_MAX, DesktopCodeStore, pkceChallenge } from './desktopCodes.js';

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const STATE = 'state-0123456789abcdefgh';

function store() {
  let t = 1_000_000;
  const s = new DesktopCodeStore(() => t);
  return { s, advance: (ms: number) => (t += ms) };
}
const issue = (s: DesktopCodeStore, state = STATE) => s.issue({ userId: 'u1', email: 'alice@example.com', challenge: CHALLENGE, state });

describe('DesktopCodeStore', () => {
  it('S256 matches the RFC 7636 test vector', () => {
    expect(pkceChallenge(VERIFIER)).toBe(CHALLENGE);
  });

  it('code: 32 random bytes base64url; only its hash is kept', () => {
    const { s } = store();
    const code = issue(s);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify([...(s as unknown as { codes: Map<string, unknown> }).codes])).not.toContain(code);
  });

  it('a fresh code with the right verifier and state → the grant', () => {
    const { s, advance } = store();
    const code = issue(s);
    advance(59_000);
    expect(s.redeem(code, VERIFIER, STATE)).toEqual({ userId: 'u1', email: 'alice@example.com' });
  });

  it('Код истёк: exchange 61 s after issue → null', () => {
    const { s, advance } = store();
    const code = issue(s);
    advance(61_000);
    expect(s.redeem(code, VERIFIER, STATE)).toBeNull();
  });

  it('Повторный обмен: the second redeem of the same code → null', () => {
    const { s } = store();
    const code = issue(s);
    expect(s.redeem(code, VERIFIER, STATE)).not.toBeNull();
    expect(s.redeem(code, VERIFIER, STATE)).toBeNull();
  });

  it('a wrong verifier burns the code: the right verifier afterwards → null', () => {
    const { s } = store();
    const code = issue(s);
    expect(s.redeem(code, 'x'.repeat(43), STATE)).toBeNull();
    expect(s.redeem(code, VERIFIER, STATE)).toBeNull();
  });

  it('a wrong state burns the code', () => {
    const { s } = store();
    const code = issue(s);
    expect(s.redeem(code, VERIFIER, 'other-state-0123456789ab')).toBeNull();
    expect(s.redeem(code, VERIFIER, STATE)).toBeNull();
  });

  it('an unknown code → null', () => {
    const { s } = store();
    expect(s.redeem('nope', VERIFIER, STATE)).toBeNull();
  });

  it('the 65th code evicts the first', () => {
    const { s } = store();
    const codes = Array.from({ length: DESKTOP_CODE_MAX + 1 }, () => issue(s));
    expect(s.size).toBe(DESKTOP_CODE_MAX);
    expect(s.redeem(codes[0]!, VERIFIER, STATE)).toBeNull();
    expect(s.redeem(codes[1]!, VERIFIER, STATE)).not.toBeNull();
    expect(s.redeem(codes[DESKTOP_CODE_MAX]!, VERIFIER, STATE)).not.toBeNull();
  });

  it('expired codes are swept on every operation', () => {
    const { s, advance } = store();
    issue(s);
    issue(s);
    advance(60_000);
    expect(s.size).toBe(0);
  });
});
