/**
 * One voice conversation per window (change voice-conversation, design D9): the page talks to the ElevenLabs agent,
 * the agent's Custom LLM is the hub, the hub passes every utterance to the session. The store owns the connection:
 * «Завершить», the page going to the background, the page closing, the composer of the conversation going away and a
 * dropped connection all end it and free the microphone.
 * Requirements (voice-conversation): Начало разговора; Полоса разговора; Итог длинного хода голосом.
 */
import { Conversation } from '@elevenlabs/client';
import { VOICE_REPORT_MARKER } from '@agent-hub/shared';
// no-inline: the worklets are small enough for Vite to inline as data: URLs, and the hub's CSP (script-src 'self')
// refuses audioWorklet.addModule on a data: URL — the conversation would fail before connecting
import rawAudioProcessor from '@elevenlabs/client/worklets/rawAudioProcessor.js?url&no-inline';
import audioConcatProcessor from '@elevenlabs/client/worklets/audioConcatProcessor.js?url&no-inline';
import { create } from 'zustand';
import { api } from '../../api/client';
import { micError } from './recorder';
import { setVoiceNote, useVoice } from './voice';

export type TalkPhase = 'connecting' | 'listening' | 'thinking' | 'speaking';

export interface Talk {
  id: number;
  sessionId: string;
  paneId: string;
  phase: TalkPhase;
  /** The last line of the conversation (Ivan's or the agent's), shown in the bar. */
  last?: string;
}

interface State {
  active: Talk | null;
}

export const useTalk = create<State>()(() => ({ active: null }));

// Notes hold the dictionary key: VoiceNote translates it when it renders.
export const TALK_FAILED_TEXT = 'chat.talk.failed';
export const TALK_DISCONNECTED_TEXT = 'chat.talk.disconnected';
export const TALK_AUDIO_FAILED_TEXT = 'chat.talk.audioFailed';

/** Requirement «Сбой звука в разговоре»: how long one resume() may take and how many suspends a conversation survives. */
export const AUDIO_RESUME_MS = 3000;
export const AUDIO_SUSPENDS_MAX = 3;

/** What the store needs of an ElevenLabs conversation. */
export interface TalkConnection {
  endSession(): Promise<void>;
  /** A user message without speech: the agent asks its Custom LLM (the hub) for an answer. */
  sendUserMessage(text: string): void;
  /** The audio contexts the SDK opened for the conversation (push-voice-fixes D6). */
  audio?: BaseAudioContext[];
}

export interface TalkCallbacks {
  onConnect: () => void;
  onDisconnect: () => void;
  onError: (message: string) => void;
  onModeChange: (p: { mode: 'speaking' | 'listening' }) => void;
  onMessage: (p: { message: string; role: 'user' | 'agent' }) => void;
}

/** Injected in tests (fake microphone, fake hub, fake ElevenLabs). */
export const talkDeps = {
  /** Asks for the microphone before the link is fetched: a denial does not spend a signed URL. The SDK opens its own stream. */
  async checkMic(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('no getUserMedia', 'NotSupportedError');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
  },
  fetchTalk: (sessionId: string) => api.voiceTalk(sessionId),
  async connect(signedUrl: string, hubToken: string, cb: TalkCallbacks): Promise<TalkConnection> {
    // the SDK does not expose its audio contexts: the ones it creates while starting are caught to watch their state
    const audio: BaseAudioContext[] = [];
    const Native = window.AudioContext;
    if (Native) {
      window.AudioContext = class extends Native {
        constructor(options?: AudioContextOptions) {
          super(options);
          audio.push(this);
        }
      };
    }
    try {
      const conv = await Conversation.startSession({
        signedUrl,
        connectionType: 'websocket',
        customLlmExtraBody: { hub_token: hubToken },
        workletPaths: { rawAudioProcessor, audioConcatProcessor },
        ...cb,
      });
      return {
        endSession: () => conv.endSession(),
        sendUserMessage: text => conv.sendUserMessage(text),
        audio,
      };
    } finally {
      if (Native) window.AudioContext = Native;
    }
  },
};

let connection: TalkConnection | null = null;
let seq = 0;
let unguard: (() => void) | null = null;

const get = () => useTalk.getState();
const current = (id: number) => get().active?.id === id;
const patch = (id: number, p: Partial<Talk>) => {
  const a = get().active;
  if (a && a.id === id) useTalk.setState({ active: { ...a, ...p } });
};

function onVisibility() {
  // Requirement «Полоса разговора»: minutes of a conversation are paid — a page in the background ends it
  if (document.visibilityState === 'hidden') void endTalk();
}

function onPageHide() {
  void endTalk();
}

function watch(on: boolean) {
  const method = on ? 'addEventListener' : 'removeEventListener';
  document[method]('visibilitychange', onVisibility);
  window[method]('pagehide', onPageHide);
}

function stopGuard() {
  unguard?.();
  unguard = null;
}

/**
 * Requirement «Сбой звука в разговоре»: a context of the conversation that suspends gets one resume(); it stays
 * suspended, closes on its own or suspends too often — the conversation ends with a note instead of a silent «Слушаю».
 */
function guardAudio(id: number, sessionId: string, contexts: BaseAudioContext[]) {
  let suspends = 0;
  const failAudio = () => {
    if (!current(id)) return;
    void endTalk();
    setVoiceNote(sessionId, TALK_AUDIO_FAILED_TEXT);
  };
  const resume = async (ctx: BaseAudioContext) => {
    suspends += 1;
    if (suspends > AUDIO_SUSPENDS_MAX) {
      failAudio();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, AUDIO_RESUME_MS);
    });
    const ac = ctx as AudioContext;
    await Promise.race([ac.resume().catch(() => undefined), timeout]);
    clearTimeout(timer);
    if (current(id) && ctx.state !== 'running') failAudio();
  };
  const check = (ctx: BaseAudioContext) => {
    if (!current(id)) return;
    if (ctx.state === 'suspended') void resume(ctx);
    // the SDK closes its contexts after onDisconnect: a close before it is a failure of the sound
    else if (ctx.state === 'closed') setTimeout(failAudio, 0);
  };
  const listeners = contexts.map(ctx => {
    const listener = () => check(ctx);
    ctx.addEventListener('statechange', listener);
    return () => ctx.removeEventListener('statechange', listener);
  });
  unguard = () => {
    for (const off of listeners) off();
  };
  for (const ctx of contexts) check(ctx);
}

/** «Разговор»: the microphone, the link from the hub, the connection. Does nothing while a dictation or another conversation runs. */
export async function startTalk(sessionId: string, paneId: string): Promise<void> {
  if (get().active || useVoice.getState().active) return;
  const id = ++seq;
  setVoiceNote(sessionId, undefined);
  useTalk.setState({ active: { id, sessionId, paneId, phase: 'connecting' } });
  watch(true);
  const fail = (note: string) => {
    if (!current(id)) return;
    watch(false);
    useTalk.setState({ active: null });
    setVoiceNote(sessionId, note);
  };
  try {
    await talkDeps.checkMic();
  } catch (err) {
    fail(micError(err).message);
    return;
  }
  if (!current(id)) return;
  let link: { signedUrl: string; token: string };
  try {
    link = await talkDeps.fetchTalk(sessionId);
  } catch {
    fail(TALK_FAILED_TEXT);
    return;
  }
  if (!current(id)) return;
  let conn: TalkConnection;
  try {
    conn = await talkDeps.connect(link.signedUrl, link.token, {
      onConnect: () => patch(id, { phase: 'listening' }),
      onDisconnect: () => {
        if (!current(id)) return;
        stopGuard();
        connection = null;
        fail(TALK_DISCONNECTED_TEXT);
      },
      onError: () => {
        // the SDK disconnects after a fatal error; onDisconnect ends the conversation
      },
      onModeChange: ({ mode }) => {
        if (mode === 'speaking') patch(id, { phase: 'speaking' });
        // «Думаю» stays until the agent speaks: listening comes back only after its speech
        else if (get().active?.phase !== 'thinking') patch(id, { phase: 'listening' });
      },
      onMessage: ({ message, role }) => {
        // the report marker is not a line of the conversation
        if (message.trim() === VOICE_REPORT_MARKER) return;
        if (role === 'user') patch(id, { phase: 'thinking', last: message });
        else if (message.trim()) patch(id, { last: message });
      },
    });
  } catch (err) {
    console.error('voice conversation: connection failed', err);
    fail(TALK_FAILED_TEXT);
    return;
  }
  if (!current(id)) {
    // «Завершить» while connecting
    void conn.endSession().catch(() => undefined);
    return;
  }
  connection = conn;
  if (conn.audio?.length) guardAudio(id, sessionId, conn.audio);
}

/**
 * D4.8: the session of the conversation ended a turn or stopped for the user. While the agent listens, the page asks it
 * for the report: the hub speaks the result or the question of a long turn, else answers nothing. A turn spoken to the
 * end ends while the agent thinks or speaks — no report then.
 */
export function reportTalk(sessionId: string): void {
  const a = get().active;
  if (!a || a.sessionId !== sessionId || a.phase !== 'listening' || !connection) return;
  connection.sendUserMessage(VOICE_REPORT_MARKER);
}

/** «Завершить», the page hidden or closed, the composer gone: closes the connection, the microphone is freed. */
export async function endTalk(): Promise<void> {
  if (!get().active) return;
  watch(false);
  stopGuard();
  const conn = connection;
  connection = null;
  useTalk.setState({ active: null });
  await conn?.endSession().catch(() => undefined);
}

/** Tests: drop the conversation. */
export function resetTalk(): void {
  watch(false);
  stopGuard();
  connection = null;
  useTalk.setState({ active: null });
}
