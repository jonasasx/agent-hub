// Store of one dictation per window (task 3.4). Requirements (voice-input): Запись голоса; Отмена записи; Завершение
// записи и вставка текста; Лимит длительности записи; Ошибки доступа к микрофону; Ошибки распознавания; Запись при
// смене контекста.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { VOICE_COUNTDOWN_MS, VOICE_MAX_DURATION_MS } from '../../api/types';
import { useStore } from '../../store';
import { resetStore } from '../../test/factories';
import { MicError, MIC_TEXT, type Recording } from './recorder';
import {
  EMPTY_TEXT,
  INTERRUPTED_TEXT,
  cancelDictation,
  claimDictation,
  finishDictation,
  resetLabel,
  resetVoice,
  retryDictation,
  setVoiceNote,
  startDictation,
  timerLabel,
  useVoice,
  voiceDeps,
  voiceErrorText,
} from './voice';

const realDeps = { ...voiceDeps };

function fakeRecording() {
  const r = {
    mime: 'audio/webm;codecs=opus',
    stopped: 0,
    cancelled: 0,
    level: () => 0.5,
    stop: vi.fn(async () => {
      r.stopped++;
      return new Blob(['voice'], { type: 'audio/webm;codecs=opus' });
    }),
    cancel: vi.fn(() => {
      r.cancelled++;
    }),
  };
  return r;
}

type Answer = { resolve: (t: string) => void; reject: (e: unknown) => void; signal: AbortSignal; blob: Blob; mime: string };

function setup() {
  const rec = fakeRecording();
  const answers: Answer[] = [];
  voiceDeps.startRecording = vi.fn(async () => rec as unknown as Recording);
  voiceDeps.transcribe = vi.fn(
    (blob: Blob, mime: string, signal?: AbortSignal) =>
      new Promise<{ text: string }>((res, rej) => {
        answers.push({ resolve: text => res({ text }), reject: rej, signal: signal!, blob, mime });
      }),
  );
  return { rec, answers };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const S = 'sess-a';
const phase = () => useVoice.getState().active?.phase ?? null;
const draft = (id = S) => useStore.getState().drafts[id];

describe('voice store', () => {
  beforeEach(() => {
    resetStore();
    resetVoice();
  });
  afterEach(() => {
    resetVoice();
    Object.assign(voiceDeps, realDeps);
    vi.useRealTimers();
  });

  it('Пустой черновик: «Готово» → «Распознаю…» → the text in the draft, no message sent', async () => {
    const { rec, answers } = setup();
    await startDictation(S, 'p1');
    expect(phase()).toBe('recording');
    void finishDictation();
    expect(phase()).toBe('transcribing');
    await flush();
    expect(rec.stop).toHaveBeenCalledTimes(1);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.mime).toBe('audio/webm;codecs=opus');
    answers[0]!.resolve('  Привет ');
    await flush();
    expect(draft()).toBe('Привет');
    expect(useVoice.getState().active).toBeNull();
  });

  it('Дописывание через пробел to the draft as it is when the answer comes', async () => {
    const { answers } = setup();
    useStore.setState({ drafts: { [S]: 'Сделай' } });
    await startDictation(S, 'p1');
    void finishDictation();
    await flush();
    // typed while recognising: kept, the text goes after it
    useStore.setState({ drafts: { [S]: 'Сделай так:' } });
    answers[0]!.resolve('проверь логи');
    await flush();
    expect(draft()).toBe('Сделай так: проверь логи');
  });

  it('Тишина: an empty answer leaves the draft and shows «Речь не распознана»', async () => {
    const { answers } = setup();
    useStore.setState({ drafts: { [S]: 'было' } });
    await startDictation(S, 'p1');
    void finishDictation();
    await flush();
    answers[0]!.resolve('   ');
    await flush();
    expect(draft()).toBe('было');
    expect(useVoice.getState().active).toBeNull();
    expect(useVoice.getState().note[S]).toBe(EMPTY_TEXT);
  });

  it('Esc / «Отмена» while recording: the microphone is released, nothing is sent, the draft stays', async () => {
    const { rec } = setup();
    useStore.setState({ drafts: { [S]: 'Проверь' } });
    await startDictation(S, 'p1');
    cancelDictation();
    expect(rec.cancel).toHaveBeenCalledTimes(1);
    expect(voiceDeps.transcribe).not.toHaveBeenCalled();
    expect(useVoice.getState().active).toBeNull();
    expect(draft()).toBe('Проверь');
  });

  it('Отмена во время распознавания: the request is aborted, a late answer is dropped', async () => {
    const { answers } = setup();
    await startDictation(S, 'p1');
    void finishDictation();
    await flush();
    cancelDictation();
    expect(answers[0]!.signal.aborted).toBe(true);
    answers[0]!.resolve('поздно');
    await flush();
    expect(draft()).toBeUndefined();
    expect(useVoice.getState().active).toBeNull();
  });

  it('a late error of a cancelled request does not bring the bar back', async () => {
    const { answers } = setup();
    await startDictation(S, 'p1');
    void finishDictation();
    await flush();
    cancelDictation();
    answers[0]!.reject(new ApiError(502, 'voice_upstream_error'));
    await flush();
    expect(useVoice.getState().active).toBeNull();
  });

  it('Повтор после ошибки: the same recording again, the microphone is not asked again', async () => {
    const { answers } = setup();
    await startDictation(S, 'p1');
    void finishDictation();
    await flush();
    answers[0]!.reject(new ApiError(502, 'voice_upstream_error'));
    await flush();
    expect(phase()).toBe('error');
    expect(useVoice.getState().active!.error).toBe('Не удалось распознать');
    expect(draft()).toBeUndefined();
    retryDictation();
    expect(phase()).toBe('transcribing');
    await flush();
    expect(answers).toHaveLength(2);
    expect(answers[1]!.blob).toBe(answers[0]!.blob);
    answers[1]!.resolve('Готово');
    await flush();
    expect(draft()).toBe('Готово');
    expect(voiceDeps.startRecording).toHaveBeenCalledTimes(1);
  });

  it('Квота исчерпана: the bar says when it resets; «Отмена» drops the kept recording', async () => {
    const { answers } = setup();
    await startDictation(S, 'p1');
    void finishDictation();
    await flush();
    answers[0]!.reject(new ApiError(402, 'voice_quota_exceeded', 'Закончилась квота ElevenLabs', { error: 'voice_quota_exceeded', resetAt: '2026-11-18T12:00:00Z' }));
    await flush();
    expect(useVoice.getState().active!.error).toBe('Закончилась квота ElevenLabs, обновится 18.11');
    cancelDictation();
    retryDictation();
    expect(answers).toHaveLength(1);
  });

  it('Доступ запрещён: no recording, the hint under the composer; pressing again asks again', async () => {
    voiceDeps.startRecording = vi.fn(async () => {
      throw new MicError('denied', MIC_TEXT.denied);
    });
    await startDictation(S, 'p1');
    expect(useVoice.getState().active).toBeNull();
    expect(useVoice.getState().note[S]).toMatch(/^Нет доступа к микрофону/);
    await startDictation(S, 'p1');
    expect(voiceDeps.startRecording).toHaveBeenCalledTimes(2);
  });

  it('Микрофона нет: a raw DOMException from the browser becomes «Микрофон не найден»', async () => {
    voiceDeps.startRecording = vi.fn(async () => {
      throw new DOMException('none', 'NotFoundError');
    });
    await startDictation(S, 'p1');
    expect(useVoice.getState().note[S]).toBe('Микрофон не найден');
  });

  it('one dictation per window: a second start while one runs does nothing', async () => {
    setup();
    await startDictation(S, 'p1');
    await startDictation('sess-b', 'p2');
    expect(voiceDeps.startRecording).toHaveBeenCalledTimes(1);
    expect(useVoice.getState().active!.sessionId).toBe(S);
  });

  it('cancelled while the browser asks for the permission: the late microphone is released at once', async () => {
    let grant: (r: Recording) => void = () => undefined;
    const rec = fakeRecording();
    voiceDeps.startRecording = vi.fn(() => new Promise<Recording>(r => (grant = r)));
    const started = startDictation(S, 'p1');
    expect(phase()).toBe('starting');
    void finishDictation({ detach: true }); // the composer went away during the prompt
    expect(useVoice.getState().active).toBeNull();
    grant(rec as unknown as Recording);
    await started;
    expect(rec.cancel).toHaveBeenCalledTimes(1);
    expect(useVoice.getState().active).toBeNull();
  });

  it('Лимит достигнут: after 5 minutes the recording goes to recognition by itself', async () => {
    vi.useFakeTimers();
    const { rec, answers } = setup();
    await startDictation(S, 'p1');
    vi.advanceTimersByTime(VOICE_MAX_DURATION_MS - 1);
    expect(phase()).toBe('recording');
    vi.advanceTimersByTime(1);
    expect(phase()).toBe('transcribing');
    await flush();
    expect(rec.stop).toHaveBeenCalledTimes(1);
    expect(answers).toHaveLength(1);
  });

  it('Телефон заблокирован: the page going hidden finishes the recording into the draft of its session', async () => {
    const { answers } = setup();
    await startDictation(S, 'p1');
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    vis.mockRestore();
    expect(phase()).toBe('transcribing');
    expect(useVoice.getState().active!.paneId).toBeNull();
    await flush();
    answers[0]!.resolve('с экрана блокировки');
    await flush();
    expect(draft()).toBe('с экрана блокировки');
  });

  it('Запись прервалась: a recorder error leaves nothing to retry — the composer back with the hint, the draft as it was', async () => {
    const { rec } = setup();
    rec.stop.mockImplementationOnce(async () => {
      throw new DOMException('gone', 'UnknownError');
    });
    useStore.setState({ drafts: { [S]: 'было' } });
    await startDictation(S, 'p1');
    await finishDictation();
    expect(useVoice.getState().active).toBeNull();
    expect(useVoice.getState().note[S]).toBe(INTERRUPTED_TEXT);
    expect(voiceDeps.transcribe).not.toHaveBeenCalled();
    expect(draft()).toBe('было');
    // nothing kept: «Повторить» has nothing to send
    retryDictation();
    expect(voiceDeps.transcribe).not.toHaveBeenCalled();
  });

  it('Запись прервалась mid-recording: the recorder error ends the dictation at once with the hint, nothing sent', async () => {
    const rec = fakeRecording();
    let fail: (e: unknown) => void = () => undefined;
    voiceDeps.startRecording = vi.fn(async (onError?: (e: unknown) => void) => {
      fail = onError!;
      return rec as unknown as Recording;
    });
    voiceDeps.transcribe = vi.fn();
    useStore.setState({ drafts: { [S]: 'было' } });
    await startDictation(S, 'p1');
    expect(phase()).toBe('recording');
    fail(new DOMException('gone', 'UnknownError'));
    expect(useVoice.getState().active).toBeNull();
    expect(useVoice.getState().note[S]).toBe(INTERRUPTED_TEXT);
    expect(rec.cancel).toHaveBeenCalledTimes(1);
    expect(voiceDeps.transcribe).not.toHaveBeenCalled();
    expect(draft()).toBe('было');
    // a later error of an ended dictation, or of a newer one's predecessor, changes nothing
    setVoiceNote(S, undefined);
    fail(new Error('again'));
    expect(useVoice.getState().note[S]).toBeUndefined();
  });

  it('claimDictation: a dictation left without a composer goes to the first composer that asks, only once', async () => {
    setup();
    await startDictation(S, 'p1');
    claimDictation(S, 'p2'); // still shown in p1: nothing to claim
    expect(useVoice.getState().active!.paneId).toBe('p1');
    void finishDictation({ detach: true });
    expect(useVoice.getState().active!.paneId).toBeNull();
    claimDictation('sess-b', 'p2'); // another session: no
    expect(useVoice.getState().active!.paneId).toBeNull();
    claimDictation(S, 'p2');
    claimDictation(S, 'p3');
    expect(useVoice.getState().active!.paneId).toBe('p2');
  });

  it('after the dictation ends, the page going hidden does nothing', async () => {
    setup();
    await startDictation(S, 'p1');
    cancelDictation();
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    vis.mockRestore();
    expect(useVoice.getState().active).toBeNull();
  });
});

describe('timerLabel (Requirement «Лимит длительности записи»)', () => {
  it('counts up from 0:00', () => {
    expect(timerLabel(0)).toEqual({ text: '0:00', countdown: false });
    expect(timerLabel(65_400)).toEqual({ text: '1:05', countdown: false });
    expect(timerLabel(VOICE_MAX_DURATION_MS - VOICE_COUNTDOWN_MS - 1)).toEqual({ text: '4:29', countdown: false });
  });
  it('Обратный отсчёт from 4:30: at 4:31 it shows 0:29 left', () => {
    expect(timerLabel(270_000)).toEqual({ text: '0:30', countdown: true });
    expect(timerLabel(271_000)).toEqual({ text: '0:29', countdown: true });
    expect(timerLabel(VOICE_MAX_DURATION_MS)).toEqual({ text: '0:00', countdown: true });
    expect(timerLabel(VOICE_MAX_DURATION_MS + 5000)).toEqual({ text: '0:00', countdown: true });
  });
});

describe('voiceErrorText (design D2 «код ответа → текст в UI»)', () => {
  it.each([
    [new ApiError(402, 'voice_quota_exceeded', undefined, {}), 'Закончилась квота ElevenLabs'],
    [new ApiError(402, 'voice_quota_exceeded', undefined, { resetAt: '2026-11-18T12:00:00Z' }), 'Закончилась квота ElevenLabs, обновится 18.11'],
    [new ApiError(429, 'voice_busy'), 'Идёт другое распознавание, повторите через несколько секунд'],
    [new ApiError(502, 'voice_key_rejected'), 'ElevenLabs отклонил ключ хаба'],
    [new ApiError(413, 'too_large'), 'Запись слишком большая'],
    [new ApiError(502, 'voice_upstream_error'), 'Не удалось распознать'],
    [new ApiError(504, 'voice_timeout'), 'Не удалось распознать'],
    [new ApiError(400, 'empty_audio'), 'Не удалось распознать'],
    [new ApiError(415, 'unsupported_audio'), 'Не удалось распознать'],
    [new ApiError(0, 'network_error'), 'Не удалось распознать'],
    [new ApiError(0, 'timeout'), 'Не удалось распознать'],
    [new TypeError('Failed to fetch'), 'Не удалось распознать'],
  ])('%s', (err, text) => {
    expect(voiceErrorText(err)).toBe(text);
  });
  it('resetLabel: ДД.ММ, nothing for garbage', () => {
    expect(resetLabel('2026-01-05T12:00:00Z')).toBe('05.01');
    expect(resetLabel('nope')).toBeNull();
    expect(resetLabel(undefined)).toBeNull();
  });
});
