import { describe, expect, it } from 'vitest';
import { parsePeerMessage, wrapPeerMessage } from './peers.js';
import { peersReplyPayload, peersRequestPayload, PEERS_PROTOCOL, PROTOCOL_VERSION, protocolAtLeast, RESULT_TEXT_MAX, sessionResultPayload, SPAWN_PROTOCOL } from './protocol.js';

const env = { from: '0b3c1b3e-6b0a-4a52-9a4e-1d0a8d6f2f11', title: 'Деплой "хаба" <1>', machine: 'X1', id: '5f1d8f7e-2b6f-4d3a-8a55-0c7a3c0b9e22' };

describe('peer-message wrapper', () => {
  it('round-trips the envelope and a plain text', () => {
    const w = wrapPeerMessage(env, 'привет\nвторая строка');
    expect(parsePeerMessage(w)).toEqual({ envelope: env, text: 'привет\nвторая строка' });
  });
  it('round-trips in-reply-to and special characters in attributes', () => {
    const e = { ...env, inReplyTo: '9a8b7c6d-1111-4222-8333-444455556666' };
    expect(parsePeerMessage(wrapPeerMessage(e, 'x'))?.envelope).toEqual(e);
  });
  it('a closing tag inside the text does not end the wrapper', () => {
    const t = 'before </peer-message> after <peer-message from="x">';
    const w = wrapPeerMessage(env, t);
    expect(w.split('</peer-message>').length).toBe(2);
    expect(parsePeerMessage(w)?.text).toBe(t);
  });
  it('is not a peer message: plain text, a prefix, a suffix, no from/id', () => {
    expect(parsePeerMessage('hello')).toBeNull();
    expect(parsePeerMessage('прочитай: ' + wrapPeerMessage(env, 'x'))).toBeNull();
    expect(parsePeerMessage(wrapPeerMessage(env, 'x') + ' хвост')).toBeNull();
    expect(parsePeerMessage('<peer-message title="a">\nx\n</peer-message>')).toBeNull();
  });
});

describe('1.9 peers messages', () => {
  const sid = env.from;
  it('peers.request takes list/get/send and refuses the rest', () => {
    expect(peersRequestPayload.safeParse({ op: 'list', sessionId: sid, status: 'waiting', limit: 5 }).success).toBe(true);
    expect(peersRequestPayload.safeParse({ op: 'get', sessionId: sid, target: env.id }).success).toBe(true);
    expect(peersRequestPayload.safeParse({ op: 'send', sessionId: sid, to: env.id, text: 'hi', inReplyTo: env.id }).success).toBe(true);
    expect(peersRequestPayload.safeParse({ op: 'send', sessionId: sid, to: 'nope', text: 'hi' }).success).toBe(false);
    expect(peersRequestPayload.safeParse({ op: 'list', sessionId: sid, limit: 1000 }).success).toBe(false);
    expect(peersRequestPayload.safeParse({ op: 'kill', sessionId: sid }).success).toBe(false);
  });
  it('peers.reply is ok+result or an error with a known code', () => {
    expect(peersReplyPayload.safeParse({ ok: true, result: { result: 'delivered' } }).success).toBe(true);
    expect(peersReplyPayload.safeParse({ ok: false, code: 'rate_limited', message: 'm', retryAfterSec: 30 }).success).toBe(true);
    expect(peersReplyPayload.safeParse({ ok: false, code: 'weird', message: 'm' }).success).toBe(false);
  });
  it('is gated by 1.9', () => {
    expect(protocolAtLeast('1.8', PEERS_PROTOCOL)).toBe(false);
    expect(protocolAtLeast('1.9', PEERS_PROTOCOL)).toBe(true);
  });
});

describe('1.12 hub subagents', () => {
  const sid = env.from;
  it('the envelope carries kind; an unknown kind is dropped', () => {
    for (const kind of ['spawn', 'report'] as const) expect(parsePeerMessage(wrapPeerMessage({ ...env, kind }, 'x'))?.envelope).toEqual({ ...env, kind });
    const odd = wrapPeerMessage(env, 'x').replace('<peer-message ', '<peer-message kind="boom" ');
    expect(parsePeerMessage(odd)?.envelope).toEqual(env);
  });
  it('the envelope carries parent="true" only when set', () => {
    const w = wrapPeerMessage({ ...env, kind: 'spawn', parent: true }, 'x');
    expect(w).toContain(' parent="true"');
    expect(parsePeerMessage(w)?.envelope).toEqual({ ...env, kind: 'spawn', parent: true });
    expect(wrapPeerMessage(env, 'x')).not.toContain('parent=');
  });
  it('peers.request takes spawn with optional placement', () => {
    expect(peersRequestPayload.safeParse({ op: 'spawn', sessionId: sid, task: 't' }).success).toBe(true);
    expect(peersRequestPayload.safeParse({ op: 'spawn', sessionId: sid, task: 't', provider: 'codex', machine: 'vm', cwd: '/x', model: 'm', title: 'T' }).success).toBe(true);
    expect(peersRequestPayload.safeParse({ op: 'spawn', sessionId: sid, task: 't', provider: 'gemini' }).success).toBe(false);
    expect(peersReplyPayload.safeParse({ ok: false, code: 'spawn_failed', message: 'm' }).success).toBe(true);
  });
  it('session.result carries a bounded resultText', () => {
    const r = { sessionId: sid, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 };
    expect(sessionResultPayload.safeParse({ ...r, resultText: 'итог' }).success).toBe(true);
    expect(sessionResultPayload.safeParse({ ...r, resultText: 'x'.repeat(RESULT_TEXT_MAX + 1) }).success).toBe(false);
    expect(protocolAtLeast('1.11', SPAWN_PROTOCOL)).toBe(false);
    expect(protocolAtLeast(PROTOCOL_VERSION, SPAWN_PROTOCOL)).toBe(true);
  });
});
