// Requirement: Приём кода приложением (desktop-auth), design D9.
import { describe, expect, it } from 'vitest';
import { PENDING_TTL_MS, PendingLoginStore, challengeOf, createState, createVerifier, startUrl } from './pkce.js';

describe('PKCE', () => {
  it('RFC 7636 appendix B vector (tasks.md 4.1 has a typo: …uEJS…, the RFC says …uGJS…)', () => {
    expect(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('verifier is 43 chars of base64url (32 bytes), state 22 chars (16 bytes); both pass the hub regexes', () => {
    const v = createVerifier();
    const s = createState();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    expect(challengeOf(v)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createVerifier()).not.toBe(v);
  });
  it('start URL carries challenge, S256 and state', () => {
    const u = new URL(startUrl('http://localhost:8080', { challenge: 'c'.repeat(43), state: 's'.repeat(22) }));
    expect(u.pathname).toBe('/auth/desktop/start');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBe('c'.repeat(43));
    expect(u.searchParams.get('state')).toBe('s'.repeat(22));
  });
});

describe('PendingLoginStore', () => {
  it('takes the pending sign-in once by its state', () => {
    const st = new PendingLoginStore();
    const p = st.begin('/s/1');
    expect(st.take('other')).toBeNull();
    expect(st.take(p.state)).toMatchObject({ verifier: p.verifier, returnPath: '/s/1' });
    expect(st.take(p.state)).toBeNull();
  });
  it('Чужой state without a pending sign-in → null', () => {
    expect(new PendingLoginStore().take('y')).toBeNull();
  });
  it('a new sign-in replaces the previous one', () => {
    const st = new PendingLoginStore();
    const a = st.begin('/');
    const b = st.begin('/');
    expect(st.take(a.state)).toBeNull();
    expect(st.take(b.state)).not.toBeNull();
  });
  it('expired after 10 minutes', () => {
    let now = 1_000_000;
    const st = new PendingLoginStore(() => now);
    const p = st.begin('/');
    now += PENDING_TTL_MS + 1;
    expect(st.hasPending()).toBe(false);
    expect(st.take(p.state)).toBeNull();
  });
});
