import { describe, expect, it } from 'vitest';
import { issueTalkToken, sameKey, TALK_TOKEN_TTL_MS, verifyTalkToken } from './talkToken.js';

const KEY = 'k'.repeat(40);

describe('conversation token (voice-conversation D2)', () => {
  it('round-trips the user and the session until it expires', () => {
    const t = issueTalkToken(KEY, { u: 'user-1', s: 'session-1', l: 'ru' }, 1000);
    expect(verifyTalkToken(KEY, t, 2000)).toEqual({ u: 'user-1', s: 'session-1', l: 'ru', exp: 1000 + TALK_TOKEN_TTL_MS });
    expect(verifyTalkToken(KEY, t, 1000 + TALK_TOKEN_TTL_MS)).toBeNull();
  });
  it('another key, a changed payload or garbage is refused', () => {
    const t = issueTalkToken(KEY, { u: 'user-1', s: 'session-1', l: 'ru' });
    expect(verifyTalkToken('x'.repeat(40), t)).toBeNull();
    const [, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'user-2', s: 'session-1', l: 'ru', exp: Date.now() + 1000 })).toString('base64url');
    expect(verifyTalkToken(KEY, `${forged}.${sig}`)).toBeNull();
    expect(verifyTalkToken(KEY, 'abc')).toBeNull();
    expect(verifyTalkToken(KEY, `${t}.x`)).toBeNull();
    expect(verifyTalkToken(KEY, undefined)).toBeNull();
  });
  it('the Bearer key is compared exactly', () => {
    expect(sameKey(KEY, KEY)).toBe(true);
    expect(sameKey(KEY + 'x', KEY)).toBe(false);
    expect(sameKey(undefined, KEY)).toBe(false);
  });
});
