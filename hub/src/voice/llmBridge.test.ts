// Change voice-conversation (D4): the bridge on a fake SessionService. Requirements: Голосовая реплика в сессии;
// Перебивание; Разрешения и длинные ходы; Вопрос с вариантами голосом; Итог длинного хода голосом.
import { describe, expect, it, vi } from 'vitest';
import { VOICE_REPORT_MARKER, parseVoiceTurn, type QuestionView, type SessionStatus } from '@agent-hub/shared';
import { HttpError, type TurnEvent } from '../sessions/service.js';
import { VoiceBridge, voiceAnswer, type BridgeSessions } from './llmBridge.js';
import type { Speech } from './speech.js';

class FakeSpeech implements Speech {
  said: string[] = [];
  ended = false;
  say(t: string) {
    if (!this.ended) this.said.push(t);
  }
  end() {
    this.ended = true;
  }
  get text() {
    return this.said.join('');
  }
}

interface FakeSessions {
  status: SessionStatus;
  alive: boolean;
  sent: string[];
  interrupts: number;
  sendError: HttpError | null;
  getError: Error | null;
  resolved: Array<{ requestId: string; answers: Record<string, string | string[]> }>;
  resolveError: HttpError | null;
  /** As SessionService: the status is written before the listener hears the end of the turn. */
  emit(e: TurnEvent): void;
  api: BridgeSessions;
}

function fakeSessions(): FakeSessions {
  let listener: ((e: TurnEvent) => void) | undefined;
  const f: FakeSessions = {
    status: 'waiting',
    alive: true,
    sent: [],
    interrupts: 0,
    sendError: null,
    getError: null,
    resolved: [],
    resolveError: null,
    emit: e => {
      if (e.kind === 'result' || e.kind === 'exited') f.status = 'waiting';
      listener?.(e);
    },
    api: {
      get: async () => {
        if (f.getError) throw f.getError;
        return { status: f.status, process_alive: f.alive, read_only_reason: null, source: 'hub' };
      },
      sendMessage: async (_u, _id, b) => {
        if (f.sendError) throw f.sendError;
        f.sent.push(b.text);
        f.status = 'working';
        return {};
      },
      interrupt: async () => {
        f.interrupts++;
        if (f.status !== 'working' && f.status !== 'permission') throw new HttpError(409, 'not_running', { key: 'hub.sessions.notFound' });
        // the interrupted turn ends with a result shortly after
        setTimeout(() => f.emit({ kind: 'result', sessionId: 's1' }), 5);
        return {};
      },
      resolvePermission: async (_u, _id, requestId, _d, extra) => {
        if (f.resolveError) throw f.resolveError;
        f.resolved.push({ requestId, answers: extra.answers });
        f.status = 'working';
        return {};
      },
      onTurnEvent: fn => {
        listener = fn;
      },
    },
  };
  return f;
}

const C = { userId: 'u1', sessionId: 's1', locale: 'ru' as const };
const live = () => new AbortController().signal;
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const partial = (text: string, messageId = 'm1', blockIndex = 0): TurnEvent => ({ kind: 'partial', sessionId: 's1', messageId, blockIndex, textDelta: text });

describe('VoiceBridge', () => {
  it('ok: the utterance goes in a <voice-turn>, the partial text is spoken, the result ends the speech', async () => {
    const f = fakeSessions();
    const b = new VoiceBridge({ sessions: f.api, maxTurnMs: 10_000 });
    const sp = new FakeSpeech();
    const p = b.answer(C, 'какая погода', sp, live());
    await tick();
    expect(f.sent).toHaveLength(1);
    expect(parseVoiceTurn(f.sent[0]!)?.text).toBe('какая погода');
    f.emit(partial('Солнечно.'));
    f.emit(partial('Плюс 20.', 'm1', 1));
    f.emit({ kind: 'partial', sessionId: 'other', messageId: 'x', blockIndex: 0, textDelta: 'чужое' });
    f.emit({ kind: 'result', sessionId: 's1' });
    expect(await p).toBe('ok');
    expect(sp.text).toBe('Солнечно. Плюс 20.');
    expect(sp.ended).toBe(true);
  });

  it('busy: a turn already running — the utterance is queued, the busy phrase is said, no interrupt', async () => {
    const f = fakeSessions();
    f.status = 'working';
    const b = new VoiceBridge({ sessions: f.api, maxTurnMs: 10_000 });
    const sp = new FakeSpeech();
    expect(await b.answer(C, 'ещё', sp, live())).toBe('busy');
    expect(f.sent).toHaveLength(1);
    expect(f.interrupts).toBe(0);
    expect(sp.text).toContain('Сессия занята');
    expect(sp.ended).toBe(true);
    // the text of that other turn is not spoken anywhere
    f.emit(partial('чужой ход'));
    expect(sp.text).not.toContain('чужой ход');
  });

  it('supersede: a new utterance interrupts the turn of the previous one; its speech ends empty', async () => {
    const f = fakeSessions();
    const b = new VoiceBridge({ sessions: f.api, maxTurnMs: 10_000 });
    const first = new FakeSpeech();
    const p1 = b.answer(C, 'первая', first, live());
    await tick();
    f.emit(partial('Начинаю'));
    const second = new FakeSpeech();
    const p2 = b.answer(C, 'вторая', second, live());
    expect(await p1).toBe('superseded');
    expect(first.ended).toBe(true);
    expect(first.text).toBe('Начинаю');
    await tick(20);
    expect(f.interrupts).toBe(1);
    expect(f.sent.map((t: string) => parseVoiceTurn(t)?.text)).toEqual(['первая', 'вторая']);
    // the result of the interrupted turn came before the second was registered: it does not end the second
    expect(second.ended).toBe(false);
    f.emit(partial('Ответ на вторую'));
    f.emit({ kind: 'result', sessionId: 's1' });
    expect(await p2).toBe('ok');
    expect(second.text).toBe('Ответ на вторую');
  });

  it('permission: the phrase is said once, the turn goes on', async () => {
    const f = fakeSessions();
    const b = new VoiceBridge({ sessions: f.api, maxTurnMs: 10_000 });
    const sp = new FakeSpeech();
    const p = b.answer(C, 'удали файл', sp, live());
    await tick();
    f.emit(partial('Нужно удалить.'));
    f.emit({ kind: 'permission', sessionId: 's1', requestId: 'r1' });
    f.emit({ kind: 'permission', sessionId: 's1', requestId: 'r1' });
    f.emit(partial('Удалил.'));
    f.emit({ kind: 'result', sessionId: 's1' });
    expect(await p).toBe('ok');
    expect(sp.text.match(/подтверди/g)).toHaveLength(1);
    expect(sp.text.endsWith('Удалил.')).toBe(true);
  });

  const question: QuestionView = {
    question: 'Какой вариант?',
    header: 'Проверка',
    multiSelect: false,
    options: [
      { label: 'Первый', description: '' },
      { label: 'Второй', description: '' },
      { label: 'Третий', description: '' },
    ],
  };

  it('question: read out, the speech closes; the next utterance answers it and speaks the rest of the turn', async () => {
    const f = fakeSessions();
    const b = new VoiceBridge({ sessions: f.api, maxTurnMs: 10_000 });
    const sp = new FakeSpeech();
    const p = b.answer(C, 'спроси меня', sp, live());
    await tick();
    f.status = 'permission';
    f.emit({ kind: 'permission', sessionId: 's1', requestId: 'r1', questions: [question] });
    expect(await p).toBe('question');
    expect(sp.ended).toBe(true);
    expect(sp.text).toContain('Какой вариант?');
    expect(sp.text).toContain('Варианты: Первый, Второй, Третий.');
    expect(sp.text).not.toContain('подтверди');

    const sp2 = new FakeSpeech();
    const p2 = b.answer(C, 'второй вариант', sp2, live());
    await tick();
    expect(f.interrupts).toBe(0);
    expect(f.sent).toHaveLength(1);
    expect(f.resolved).toEqual([{ requestId: 'r1', answers: { 'Какой вариант?': 'Второй' } }]);
    f.emit(partial('Выбран второй.'));
    f.emit({ kind: 'result', sessionId: 's1' });
    expect(await p2).toBe('ok');
    expect(sp2.text).toBe('Выбран второй.');
  });

  it('question answered on the screen meanwhile: the utterance goes as a usual one', async () => {
    const f = fakeSessions();
    const b = new VoiceBridge({ sessions: f.api, maxTurnMs: 10_000, supersedeWaitMs: 50 });
    const p = b.answer(C, 'спроси меня', new FakeSpeech(), live());
    await tick();
    f.emit({ kind: 'permission', sessionId: 's1', requestId: 'r1', questions: [question] });
    expect(await p).toBe('question');
    f.resolveError = new HttpError(409, 'already_resolved', { key: 'hub.sessions.alreadyResolved' });
    const sp2 = new FakeSpeech();
    const p2 = b.answer(C, 'что дальше', sp2, live());
    // the fake interrupt's 5 ms timer starts only after the rejected answer, so a fixed sleep raced it under load
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    expect(f.interrupts).toBe(1);
    f.emit(partial('Дальше так.'));
    f.emit({ kind: 'result', sessionId: 's1' });
    expect(await p2).toBe('ok');
  });

  it('voiceAnswer: a label, a number, the last one said, own text, whole words only', () => {
    expect(voiceAnswer(question, 'давай третий')).toBe('Третий');
    expect(voiceAnswer(question, 'вариант 2')).toBe('Второй');
    expect(voiceAnswer(question, 'не первый, а второй')).toBe('Второй');
    expect(voiceAnswer(question, 'the second one')).toBe('Второй');
    expect(voiceAnswer(question, '  никакой не подходит ')).toBe('никакой не подходит');
    const yesNo: QuestionView = {
      ...question,
      options: [
        { label: 'Да', description: '' },
        { label: 'Нет', description: '' },
      ],
    };
    expect(voiceAnswer(yesNo, 'давай подумаем')).toBe('давай подумаем');
    expect(voiceAnswer(yesNo, 'да, конечно')).toBe('Да');
    expect(voiceAnswer({ ...question, multiSelect: true }, 'первый и третий')).toEqual(['Первый', 'Третий']);
    const forms: QuestionView = {
      ...question,
      options: [
        { label: 'Озвучка итога', description: '' },
        { label: 'Карточка в ленте (Recommended)', description: '' },
      ],
    };
    expect(voiceAnswer(forms, 'Озвучкой итогом.')).toBe('Озвучка итога');
    expect(voiceAnswer(forms, 'давай карточку в ленте')).toBe('Карточка в ленте (Recommended)');
    expect(voiceAnswer(forms, 'озвучивать не надо')).toBe('озвучивать не надо');
  });

  it('report: the end of a long turn is spoken on the marker, once; the marker never reaches the session', async () => {
    const f = fakeSessions();
    const b = new VoiceBridge({ sessions: f.api, maxTurnMs: 30 });
    expect(await b.answer(C, 'собери отчёт', new FakeSpeech(), live())).toBe('long');
    f.emit(partial('Читаю логи.'));
    f.emit(partial('Отчёт готов, ошибок нет.', 'm2'));
    f.emit({ kind: 'result', sessionId: 's1' });
    await tick();
    const sp = new FakeSpeech();
    expect(await b.answer(C, VOICE_REPORT_MARKER, sp, live())).toBe('report');
    expect(sp.text).toBe('Отчёт готов, ошибок нет.');
    expect(sp.ended).toBe(true);
    expect(f.sent).toHaveLength(1);
    const again = new FakeSpeech();
    expect(await b.answer(C, VOICE_REPORT_MARKER, again, live())).toBe('report');
    expect(again.text).toBe('');
    expect(again.ended).toBe(true);
  });

  it('report: a question of a long turn is read on the marker, the next utterance answers it', async () => {
    const f = fakeSessions();
    const b = new VoiceBridge({ sessions: f.api, maxTurnMs: 30 });
    expect(await b.answer(C, 'собери отчёт', new FakeSpeech(), live())).toBe('long');
    f.status = 'permission';
    f.emit({ kind: 'permission', sessionId: 's1', requestId: 'r1', questions: [question] });
    const sp = new FakeSpeech();
    expect(await b.answer(C, VOICE_REPORT_MARKER, sp, live())).toBe('question');
    expect(sp.text).toContain('Какой вариант?');
    expect(sp.text).toContain('Варианты: Первый, Второй, Третий.');
    const sp2 = new FakeSpeech();
    const p2 = b.answer(C, 'третий', sp2, live());
    await tick();
    expect(f.resolved).toEqual([{ requestId: 'r1', answers: { 'Какой вариант?': 'Третий' } }]);
    f.emit(partial('Сделал третий.'));
    f.emit({ kind: 'result', sessionId: 's1' });
    expect(await p2).toBe('ok');
    expect(sp2.text).toBe('Сделал третий.');
    const after = new FakeSpeech();
    expect(await b.answer(C, VOICE_REPORT_MARKER, after, live())).toBe('report');
    expect(after.text).toBe('');
  });

  it('report: a new utterance makes the pending report stale', async () => {
    const f = fakeSessions();
    const b = new VoiceBridge({ sessions: f.api, maxTurnMs: 30 });
    expect(await b.answer(C, 'собери отчёт', new FakeSpeech(), live())).toBe('long');
    f.emit(partial('Готово.'));
    f.emit({ kind: 'result', sessionId: 's1' });
    await tick();
    const p = b.answer(C, 'а что ещё', new FakeSpeech(), live());
    await tick();
    f.emit(partial('Ничего.'));
    f.emit({ kind: 'result', sessionId: 's1' });
    expect(await p).toBe('ok');
    const sp = new FakeSpeech();
    expect(await b.answer(C, VOICE_REPORT_MARKER, sp, live())).toBe('report');
    expect(sp.text).toBe('');
  });

  it('long: the phrase ends the speech, the turn goes on, the next utterance is queued, not interrupting', async () => {
    const f = fakeSessions();
    const b = new VoiceBridge({ sessions: f.api, maxTurnMs: 30 });
    const sp = new FakeSpeech();
    expect(await b.answer(C, 'собери отчёт', sp, live())).toBe('long');
    expect(sp.ended).toBe(true);
    expect(sp.text.length).toBeGreaterThan(0);
    f.emit(partial('поздний текст'));
    expect(sp.text).not.toContain('поздний текст');
    const next = new FakeSpeech();
    expect(await b.answer(C, 'как дела', next, live())).toBe('busy');
    expect(f.interrupts).toBe(0);
    // the long turn ends: the next utterance starts a new spoken turn
    f.status = 'waiting';
    f.emit({ kind: 'result', sessionId: 's1' });
    await tick();
    const third = new FakeSpeech();
    const p3 = b.answer(C, 'готово?', third, live());
    await tick();
    f.emit(partial('Да.'));
    f.emit({ kind: 'result', sessionId: 's1' });
    expect(await p3).toBe('ok');
    expect(third.text).toBe('Да.');
  });

  it('offline and failed: the phrase is said, nothing stays registered', async () => {
    const f = fakeSessions();
    const b = new VoiceBridge({ sessions: f.api, maxTurnMs: 10_000 });
    f.sendError = new HttpError(409, 'runner_offline', { key: 'hub.sessions.notFound' });
    const a = new FakeSpeech();
    expect(await b.answer(C, 'раз', a, live())).toBe('offline');
    expect(a.ended).toBe(true);
    expect(a.text.length).toBeGreaterThan(0);
    f.sendError = new HttpError(500, 'internal', { key: 'hub.sessions.notFound' });
    const c = new FakeSpeech();
    expect(await b.answer(C, 'два', c, live())).toBe('failed');
    expect(c.text).not.toBe(a.text);
    f.sendError = null;
    f.getError = new Error('db down');
    expect(await b.answer(C, 'три', new FakeSpeech(), live())).toBe('failed');
    f.getError = null;
    // a failed send left no turn: the next utterance does not try to interrupt
    const d = new FakeSpeech();
    const p = b.answer(C, 'четыре', d, live());
    await tick();
    f.emit({ kind: 'result', sessionId: 's1' });
    expect(await p).toBe('ok');
    expect(f.interrupts).toBe(0);
  });

  it('exited: the process died in the turn', async () => {
    const f = fakeSessions();
    const b = new VoiceBridge({ sessions: f.api, maxTurnMs: 10_000 });
    const sp = new FakeSpeech();
    const p = b.answer(C, 'x', sp, live());
    await tick();
    f.emit({ kind: 'exited', sessionId: 's1' });
    expect(await p).toBe('exited');
    expect(sp.ended).toBe(true);
  });

  it('client gone (barge-in): the speech is dropped, the turn stays and the next utterance interrupts it', async () => {
    const f = fakeSessions();
    const b = new VoiceBridge({ sessions: f.api, maxTurnMs: 10_000 });
    const gone = new AbortController();
    const sp = new FakeSpeech();
    const p = b.answer(C, 'длинный рассказ', sp, gone.signal);
    await tick();
    f.emit(partial('Жил-был'));
    gone.abort();
    f.emit(partial(' кот'));
    expect(sp.text).toBe('Жил-был');
    const next = new FakeSpeech();
    const p2 = b.answer(C, 'стоп', next, live());
    expect(await p).toBe('superseded');
    await tick(20);
    expect(f.interrupts).toBe(1);
    f.emit({ kind: 'result', sessionId: 's1' });
    expect(await p2).toBe('ok');
  });
});
