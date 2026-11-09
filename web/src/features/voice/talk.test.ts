// Store of one voice conversation per window (change voice-conversation, task 4.x). Requirements (voice-conversation):
// Начало разговора; Полоса разговора; Итог длинного хода голосом.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore } from '../../test/factories';
import { MIC_TEXT, type Recording } from './recorder';
import { VOICE_REPORT_MARKER } from '@agent-hub/shared';
import {
  AUDIO_RESUME_MS,
  AUDIO_SUSPENDS_MAX,
  TALK_AUDIO_FAILED_TEXT,
  TALK_DISCONNECTED_TEXT,
  TALK_FAILED_TEXT,
  endTalk,
  reportTalk,
  resetTalk,
  startTalk,
  talkDeps,
  useTalk,
  type TalkCallbacks,
} from './talk';
import { resetVoice, startDictation, useVoice, voiceDeps } from './voice';

vi.mock('@elevenlabs/client', () => ({
  Conversation: {
    // the SDK opens its contexts while it starts (input and output)
    startSession: vi.fn(async () => {
      new AudioContext();
      new AudioContext({ sampleRate: 16000 });
      return { endSession: vi.fn(async () => undefined), sendUserMessage: vi.fn() };
    }),
  },
}));

const realDeps = { ...talkDeps };
const realVoiceDeps = { ...voiceDeps };

/** An audio context of the SDK: the state and statechange are driven by the test. */
class FakeAudio extends EventTarget {
  state: AudioContextState = 'running';
  /** What resume() does: «running» wakes the context, «never» leaves the promise hanging, «stay» resolves and keeps it suspended. */
  onResume: 'running' | 'never' | 'stay' = 'running';
  resume = vi.fn((): Promise<void> => {
    if (this.onResume === 'never') return new Promise<void>(() => undefined);
    if (this.onResume === 'running') this.go('running');
    return Promise.resolve();
  });
  go(state: AudioContextState) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

function setup(audio?: FakeAudio[]) {
  const conn = { endSession: vi.fn(async () => undefined), sendUserMessage: vi.fn((_text: string) => undefined), ...(audio ? { audio: audio as unknown as BaseAudioContext[] } : {}) };
  const calls: { signedUrl: string; token: string; cb: TalkCallbacks }[] = [];
  talkDeps.checkMic = vi.fn(async () => undefined);
  talkDeps.fetchTalk = vi.fn(async () => ({ signedUrl: 'wss://el/x', token: 'tok' }));
  talkDeps.connect = vi.fn(async (signedUrl: string, token: string, cb: TalkCallbacks) => {
    calls.push({ signedUrl, token, cb });
    return conn;
  });
  return { conn, calls };
}

const S = 'sess-a';
const active = () => useTalk.getState().active;
const note = (id = S) => useVoice.getState().note[id];

describe('talk store', () => {
  beforeEach(() => {
    resetStore();
    resetVoice();
    resetTalk();
  });
  afterEach(() => {
    resetTalk();
    resetVoice();
    Object.assign(talkDeps, realDeps);
    Object.assign(voiceDeps, realVoiceDeps);
  });

  it('phases: connecting → listening → thinking on the user line → speaking → listening', async () => {
    const { calls } = setup();
    const p = startTalk(S, 'p1');
    expect(active()?.phase).toBe('connecting');
    await p;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signedUrl).toBe('wss://el/x');
    expect(calls[0]!.token).toBe('tok');
    const cb = calls[0]!.cb;
    cb.onConnect();
    expect(active()?.phase).toBe('listening');
    cb.onMessage({ message: 'какая погода', role: 'user' });
    expect(active()).toMatchObject({ phase: 'thinking', last: 'какая погода' });
    // the agent's mode «listening» does not drop «Думаю» before it speaks
    cb.onModeChange({ mode: 'listening' });
    expect(active()?.phase).toBe('thinking');
    cb.onModeChange({ mode: 'speaking' });
    cb.onMessage({ message: 'Солнечно', role: 'agent' });
    expect(active()).toMatchObject({ phase: 'speaking', last: 'Солнечно' });
    cb.onModeChange({ mode: 'listening' });
    expect(active()?.phase).toBe('listening');
  });

  it('report: the marker goes only while the agent listens, to the session of the conversation; it is not a line', async () => {
    const { conn, calls } = setup();
    await startTalk(S, 'p1');
    const cb = calls[0]!.cb;
    reportTalk(S);
    expect(conn.sendUserMessage).not.toHaveBeenCalled();
    cb.onConnect();
    reportTalk('sess-b');
    expect(conn.sendUserMessage).not.toHaveBeenCalled();
    reportTalk(S);
    expect(conn.sendUserMessage).toHaveBeenCalledWith(VOICE_REPORT_MARKER);
    cb.onMessage({ message: VOICE_REPORT_MARKER, role: 'user' });
    expect(active()).toMatchObject({ phase: 'listening' });
    expect(active()?.last).toBeUndefined();
    cb.onModeChange({ mode: 'speaking' });
    reportTalk(S);
    expect(conn.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('a denied microphone: the note, no link spent', async () => {
    setup();
    talkDeps.checkMic = vi.fn(async () => {
      throw new DOMException('no', 'NotAllowedError');
    });
    await startTalk(S, 'p1');
    expect(talkDeps.fetchTalk).not.toHaveBeenCalled();
    expect(active()).toBeNull();
    expect(note()).toBe(MIC_TEXT.denied);
  });

  it('the hub refuses the link or the connection fails: «не удалось начать разговор»', async () => {
    setup();
    talkDeps.fetchTalk = vi.fn(async () => {
      throw new Error('423');
    });
    await startTalk(S, 'p1');
    expect(active()).toBeNull();
    expect(note()).toBe(TALK_FAILED_TEXT);
    expect(talkDeps.connect).not.toHaveBeenCalled();
    setup();
    talkDeps.connect = vi.fn(async () => {
      throw new Error('ws');
    });
    await startTalk(S, 'p1');
    expect(active()).toBeNull();
    expect(note()).toBe(TALK_FAILED_TEXT);
  });

  it('«Завершить» closes the connection; a dropped connection shows the note', async () => {
    const { conn, calls } = setup();
    await startTalk(S, 'p1');
    await endTalk();
    expect(conn.endSession).toHaveBeenCalledTimes(1);
    expect(active()).toBeNull();
    // the SDK reports the disconnect after endSession: no note for a conversation already ended
    calls[0]!.cb.onDisconnect();
    expect(note()).toBeUndefined();
    await startTalk(S, 'p1');
    calls[1]!.cb.onDisconnect();
    expect(active()).toBeNull();
    expect(note()).toBe(TALK_DISCONNECTED_TEXT);
  });

  it('«Завершить» while connecting: the late connection is closed', async () => {
    const { conn } = setup();
    let release!: () => void;
    talkDeps.fetchTalk = vi.fn(() => new Promise<{ signedUrl: string; token: string }>(res => (release = () => res({ signedUrl: 'u', token: 't' }))));
    const p = startTalk(S, 'p1');
    await Promise.resolve();
    await endTalk();
    release();
    await p;
    expect(talkDeps.connect).not.toHaveBeenCalled();
    expect(active()).toBeNull();
    expect(conn.endSession).not.toHaveBeenCalled();
  });

  it('the page going to the background ends the conversation', async () => {
    const { conn } = setup();
    await startTalk(S, 'p1');
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    vis.mockRestore();
    await Promise.resolve();
    expect(active()).toBeNull();
    expect(conn.endSession).toHaveBeenCalledTimes(1);
  });

  it('one at a time: no dictation during a conversation, no conversation during a dictation', async () => {
    setup();
    const rec = { mime: 'audio/webm', level: () => 0, stop: vi.fn(async () => new Blob()), cancel: vi.fn() };
    voiceDeps.startRecording = vi.fn(async () => rec as unknown as Recording);
    await startTalk(S, 'p1');
    await startDictation(S, 'p1');
    expect(voiceDeps.startRecording).not.toHaveBeenCalled();
    await startTalk('sess-b', 'p2');
    expect(active()?.sessionId).toBe(S);
    await endTalk();
    await startDictation(S, 'p1');
    expect(useVoice.getState().active).not.toBeNull();
    await startTalk(S, 'p1');
    expect(active()).toBeNull();
    expect(talkDeps.checkMic).toHaveBeenCalledTimes(1);
  });
  describe('the sound of the conversation fails (push-voice-fixes)', () => {
    afterEach(() => vi.useRealTimers());
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    it('a context that suspends gets resume(); waking up keeps the conversation', async () => {
      const ctx = new FakeAudio();
      const { calls } = setup([ctx]);
      await startTalk(S, 'p1');
      calls[0]!.cb.onConnect();
      ctx.go('suspended');
      await flush();
      expect(ctx.resume).toHaveBeenCalledTimes(1);
      expect(active()?.phase).toBe('listening');
      expect(note()).toBeUndefined();
    });

    it('a context that stays suspended after 3 s ends the conversation with a note', async () => {
      vi.useFakeTimers();
      const ctx = new FakeAudio();
      ctx.onResume = 'never';
      const { conn, calls } = setup([ctx]);
      await startTalk(S, 'p1');
      calls[0]!.cb.onConnect();
      ctx.go('suspended');
      await vi.advanceTimersByTimeAsync(AUDIO_RESUME_MS - 100);
      expect(active()).not.toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(active()).toBeNull();
      expect(note()).toBe(TALK_AUDIO_FAILED_TEXT);
      expect(conn.endSession).toHaveBeenCalled();
    });

    it('a resume() that resolves but leaves the context suspended ends the conversation', async () => {
      const ctx = new FakeAudio();
      ctx.onResume = 'stay';
      const { calls } = setup([ctx]);
      await startTalk(S, 'p1');
      calls[0]!.cb.onConnect();
      ctx.go('suspended');
      await flush();
      expect(active()).toBeNull();
      expect(note()).toBe(TALK_AUDIO_FAILED_TEXT);
    });

    it('a context already suspended when the connection comes is checked at once', async () => {
      const ctx = new FakeAudio();
      ctx.state = 'suspended';
      ctx.onResume = 'stay';
      setup([ctx]);
      await startTalk(S, 'p1');
      await flush();
      expect(ctx.resume).toHaveBeenCalledTimes(1);
      expect(note()).toBe(TALK_AUDIO_FAILED_TEXT);
    });

    it(`more than ${AUDIO_SUSPENDS_MAX} suspends end the conversation even when each resume() works`, async () => {
      const ctx = new FakeAudio();
      const { calls } = setup([ctx]);
      await startTalk(S, 'p1');
      calls[0]!.cb.onConnect();
      for (let i = 0; i < AUDIO_SUSPENDS_MAX; i++) {
        ctx.go('suspended');
        await flush();
      }
      expect(active()).not.toBeNull();
      ctx.go('suspended');
      await flush();
      expect(active()).toBeNull();
      expect(note()).toBe(TALK_AUDIO_FAILED_TEXT);
    });

    it('a context that closes on its own ends the conversation with the note', async () => {
      vi.useFakeTimers();
      const ctx = new FakeAudio();
      const { calls } = setup([ctx]);
      await startTalk(S, 'p1');
      calls[0]!.cb.onConnect();
      ctx.go('closed');
      await vi.advanceTimersByTimeAsync(1);
      expect(active()).toBeNull();
      expect(note()).toBe(TALK_AUDIO_FAILED_TEXT);
    });

    it('a dropped connection keeps its own note when the SDK closes the contexts right after', async () => {
      vi.useFakeTimers();
      const ctx = new FakeAudio();
      const { calls } = setup([ctx]);
      await startTalk(S, 'p1');
      calls[0]!.cb.onConnect();
      ctx.go('closed');
      calls[0]!.cb.onDisconnect();
      await vi.advanceTimersByTimeAsync(1);
      expect(note()).toBe(TALK_DISCONNECTED_TEXT);
    });

    it('«Завершить» closes the contexts without a note', async () => {
      const ctx = new FakeAudio();
      const { conn, calls } = setup([ctx]);
      conn.endSession.mockImplementation(async () => {
        ctx.go('closed');
        return undefined;
      });
      await startTalk(S, 'p1');
      calls[0]!.cb.onConnect();
      await endTalk();
      await flush();
      expect(active()).toBeNull();
      expect(note()).toBeUndefined();
    });
  });
  it('connect catches the audio contexts the SDK opens while starting and puts the constructor back', async () => {
    class StubAudio {
      constructor(public options?: AudioContextOptions) {}
    }
    const prev = window.AudioContext;
    window.AudioContext = StubAudio as unknown as typeof AudioContext;
    try {
      const conn = await realDeps.connect('wss://el/x', 'tok', {} as TalkCallbacks);
      expect(conn.audio).toHaveLength(2);
      expect(conn.audio![1]).toBeInstanceOf(StubAudio);
      expect((conn.audio![1] as unknown as StubAudio).options).toEqual({ sampleRate: 16000 });
      expect(window.AudioContext).toBe(StubAudio);
    } finally {
      window.AudioContext = prev;
    }
  });
});
