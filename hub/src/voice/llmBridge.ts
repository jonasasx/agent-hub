// Voice conversation bridge (change voice-conversation, design D4): an utterance of the ElevenLabs agent becomes a turn of
// the hub session, the text of that turn is spoken back. Requirements: Голосовая реплика в сессии; Перебивание;
// Разрешения и длинные ходы; Вопрос с вариантами голосом; Итог длинного хода голосом.
import { randomUUID } from 'node:crypto';
import { VOICE_REPORT_MARKER, wrapVoiceTurn, type Locale, type QuestionView, type SessionStatus } from '@agent-hub/shared';
import { tr } from '../i18n.js';
import { HttpError, type TurnEvent } from '../sessions/service.js';
import type { Speech } from './speech.js';

/** What the bridge needs of SessionService (a fake in tests). */
export interface BridgeSessions {
  get(userId: string, id: string): Promise<{ status: SessionStatus; process_alive: boolean; read_only_reason: string | null; source: string }>;
  sendMessage(userId: string, id: string, b: { text: string; clientUuid: string }): Promise<unknown>;
  interrupt(userId: string, id: string): Promise<unknown>;
  resolvePermission(userId: string, id: string, requestId: string, decision: 'allow', extra: { answers: Record<string, string | string[]> }): Promise<unknown>;
  onTurnEvent(fn: (e: TurnEvent) => void): void;
}

export interface BridgeOptions {
  sessions: BridgeSessions;
  /** VOICE_TURN_MAX_MS: a longer turn is not spoken to the end. */
  maxTurnMs: number;
  /** How long a new utterance waits for the interrupted turn to end, ms (default 5 s). */
  supersedeWaitMs?: number;
}

/** `result` of the log line (D4): never the text. */
export type VoiceTurnResult = 'ok' | 'superseded' | 'busy' | 'long' | 'offline' | 'failed' | 'exited' | 'client_closed' | 'question' | 'report';

/** An option by its number: ordinal words (ru, en) and digits, 1–4. English «one» is left out: «the second one». */
const ORDINALS = [
  /(?<![\p{L}\d])(перв\p{L}*|один|1|first)(?![\p{L}\d])/giu,
  /(?<![\p{L}\d])(втор\p{L}*|два|2|second|two)(?![\p{L}\d])/giu,
  /(?<![\p{L}\d])(трет\p{L}*|три|3|third|three)(?![\p{L}\d])/giu,
  /(?<![\p{L}\d])(четв[её]рт\p{L}*|четыре|4|fourth|four)(?![\p{L}\d])/giu,
];

/**
 * D4.7: the answer of an utterance to one question — labels named in it, else options named by number (the last one
 * said wins for a single choice: «не первый, а второй»), else the utterance itself as the user's own answer.
 */
export function voiceAnswer(q: QuestionView, said: string): string | string[] {
  const byLabel = q.options.filter(o => o.label.trim() && wordsIn(said, o.label.trim())).map(o => o.label);
  if (byLabel.length) return q.multiSelect ? byLabel : byLabel[byLabel.length - 1]!;
  const byNumber = q.options
    .map((o, i) => ({ label: o.label, at: i < ORDINALS.length ? Math.max(-1, ...[...said.matchAll(ORDINALS[i]!)].map(m => m.index)) : -1 }))
    .filter(x => x.at >= 0)
    .sort((a, b) => a.at - b.at);
  if (byNumber.length) return q.multiSelect ? byNumber.map(x => x.label) : byNumber[byNumber.length - 1]!.label;
  return said.trim();
}

/**
 * The words of `label` said in a row, in any form: a word longer than 3 letters matches by its stem with up to 4 letters
 * of ending («Озвучкой итогом» names «Озвучка итога»), a short one only whole («Да» does not match «давай»). A note in
 * brackets («(Recommended)») is not said.
 */
function wordsIn(said: string, label: string): boolean {
  const words = label.replace(/\([^)]*\)/g, ' ').match(/[\p{L}\d]+/gu);
  if (!words) return false;
  const stems = words.map(w => (w.length > 3 ? `${w.slice(0, Math.max(3, w.length - 2))}\\p{L}{0,4}` : w));
  return new RegExp(`(?<![\\p{L}\\d])${stems.join('[^\\p{L}\\d]+')}(?![\\p{L}\\d])`, 'iu').test(said);
}

/** An AskUserQuestion request waiting for the next utterance (D4.7). */
interface Asking {
  requestId: string;
  questions: QuestionView[];
}

/** One utterance being answered. Lives in the map until its turn ends (result or exited). */
class VoiceTurn {
  /** Speech still listened to; null after supersede, the long-task phrase or the client gone. */
  speech: Speech | null;
  /** The long-task phrase was said: the turn goes on, a new utterance does not interrupt it. */
  detached = false;
  /** A newer utterance interrupted this turn. */
  superseded = false;
  /** The question read out and not answered yet: the next utterance answers it instead of interrupting the turn. */
  asking: Asking | null = null;
  /** D4.8: what a detached turn said with nobody listening — the last text block, its question or permission phrase. */
  unsaid = '';
  private blockText = '';
  private onAsked: (() => void) | null = null;
  private lastBlock: string | null = null;
  private permissionSaid = false;
  private finish!: (r: VoiceTurnResult) => void;
  readonly finished = new Promise<VoiceTurnResult>(r => (this.finish = r));
  private settled = false;

  constructor(
    speech: Speech,
    private readonly locale: Locale,
  ) {
    this.speech = speech;
  }

  onEvent(e: TurnEvent): void {
    switch (e.kind) {
      case 'partial': {
        const block = `${e.messageId}:${e.blockIndex}`;
        if (block !== this.lastBlock) {
          if (this.lastBlock !== null) this.speech?.say(' ');
          this.blockText = '';
        }
        this.lastBlock = block;
        this.blockText += e.textDelta;
        this.speech?.say(e.textDelta);
        if (this.unheard) this.unsaid = this.blockText;
        return;
      }
      case 'permission':
        if (e.questions?.length) return this.ask({ requestId: e.requestId, questions: e.questions });
        if (this.unheard) this.unsaid = tr(this.locale).text('hub.voiceTalk.permission');
        else if (!this.permissionSaid) {
          this.permissionSaid = true;
          this.speech?.say(` ${tr(this.locale).text('hub.voiceTalk.permission')} `);
        }
        return;
      case 'result':
        return this.settle('ok');
      case 'exited':
        return this.settle('exited');
    }
  }

  /** Resolves when the turn asks a question; the speech is closed then, so the user can answer. */
  asked(): Promise<'question'> {
    return new Promise(r => (this.onAsked = () => r('question')));
  }

  private ask(a: Asking): void {
    this.asking = a;
    const t = tr(this.locale);
    const phrase = a.questions.map(q => `${q.question} ${t.text('hub.voiceTalk.options', { options: q.options.map(o => o.label).join(', ') })}`).join(' ');
    if (this.unheard) this.unsaid = phrase;
    else this.speech?.say(` ${phrase}`);
    this.release();
    this.onAsked?.();
  }

  /** Ends the speech (an empty stop for a superseded one) and stops listening to it. */
  release(phrase?: string): void {
    const s = this.speech;
    this.speech = null;
    if (!s || s.ended) return;
    if (phrase) s.say(` ${phrase}`);
    s.end();
  }

  /** Detached and nobody listens: the text waits for the report marker (D4.8). */
  private get unheard(): boolean {
    return this.detached && !this.speech;
  }

  get open(): boolean {
    return !this.settled;
  }

  settle(r: VoiceTurnResult): void {
    if (this.settled) return;
    this.settled = true;
    this.release();
    this.finish(this.superseded ? 'superseded' : r);
  }
}

export class VoiceBridge {
  private readonly turns = new Map<string, VoiceTurn>();
  /** D4.8: the last words of a detached turn that ended, spoken on the report marker. */
  private readonly reports = new Map<string, string>();

  constructor(private readonly o: BridgeOptions) {
    o.sessions.onTurnEvent(e => this.turns.get(e.sessionId)?.onEvent(e));
  }

  /**
   * Answers one utterance into `speech` and ends it. `gone` — ElevenLabs closed the request (a barge-in or a hang-up):
   * the speech is dropped, the turn goes on and the next utterance interrupts it.
   */
  async answer(c: { userId: string; sessionId: string; locale: Locale }, text: string, speech: Speech, gone: AbortSignal): Promise<VoiceTurnResult> {
    const t = tr(c.locale);
    const say = (key: Parameters<typeof t.text>[0], r: VoiceTurnResult): VoiceTurnResult => {
      speech.say(t.text(key));
      speech.end();
      return r;
    };

    if (text.trim() === VOICE_REPORT_MARKER) return this.report(c.sessionId, speech);
    // a new utterance makes the report of an earlier long turn stale
    this.reports.delete(c.sessionId);

    const prev = this.turns.get(c.sessionId);
    // D4.7: the utterance answers the question the turn read out; this speech goes on with the turn
    if (prev?.asking && prev.open && !gone.aborted) {
      const a = prev.asking;
      prev.asking = null;
      // the speech follows the turn again: its text is heard, not kept for a report
      prev.detached = false;
      prev.unsaid = '';
      const answers = Object.fromEntries(a.questions.map(q => [q.question, voiceAnswer(q, text)]));
      try {
        await this.o.sessions.resolvePermission(c.userId, c.sessionId, a.requestId, 'allow', { answers });
        prev.speech = speech;
        return await this.follow(c, prev, speech, gone);
      } catch (err) {
        // answered on the screen meanwhile: the utterance goes as a usual one
        if (!(err instanceof HttpError && (err.code === 'already_resolved' || err.code === 'not_found'))) return say('hub.voiceTalk.failed', 'failed');
      }
    }

    // Перебивание: the turn of the previous utterance stops; its request (if still open) ends with an empty stop.
    if (prev && !prev.detached && prev.open) {
      prev.superseded = true;
      prev.release();
      try {
        await this.o.sessions.interrupt(c.userId, c.sessionId);
      } catch (err) {
        if (!(err instanceof HttpError && err.code === 'not_running')) throw err;
      }
      // the result of the interrupted turn must not end the next one: it is awaited before the next turn is registered
      await Promise.race([prev.finished, new Promise(r => setTimeout(r, this.o.supersedeWaitMs ?? 5000))]);
      prev.settle('superseded');
      if (this.turns.get(c.sessionId) === prev) this.turns.delete(c.sessionId);
    }
    if (gone.aborted) return 'client_closed';

    let s: { status: SessionStatus; process_alive: boolean };
    try {
      s = await this.o.sessions.get(c.userId, c.sessionId);
    } catch {
      return say('hub.voiceTalk.failed', 'failed');
    }
    const turn = new VoiceTurn(speech, c.locale);
    // A turn not started by this utterance (typed, a peer's, a long voice task): the utterance waits in its queue.
    const busy = s.process_alive && (s.status === 'working' || s.status === 'permission');
    if (!busy) this.turns.set(c.sessionId, turn);
    try {
      await this.o.sessions.sendMessage(c.userId, c.sessionId, { text: wrapVoiceTurn(text), clientUuid: randomUUID() });
    } catch (err) {
      if (this.turns.get(c.sessionId) === turn) this.turns.delete(c.sessionId);
      turn.speech = null;
      const offline = err instanceof HttpError && err.code === 'runner_offline';
      return offline ? say('hub.voiceTalk.offline', 'offline') : say('hub.voiceTalk.failed', 'failed');
    }
    if (busy) return say('hub.voiceTalk.busy', 'busy');
    return this.follow(c, turn, speech, gone);
  }

  /**
   * D4.8: the page sends the marker when a long turn ended or stopped for the user. The pending words are spoken — the
   * question or permission of a running turn, else the end of a finished one; the marker never reaches the session.
   */
  private report(sessionId: string, speech: Speech): VoiceTurnResult {
    const turn = this.turns.get(sessionId);
    let said: string;
    if (turn?.detached && turn.open && turn.unsaid.trim()) {
      said = turn.unsaid.trim();
      turn.unsaid = '';
    } else {
      said = this.reports.get(sessionId) ?? '';
      this.reports.delete(sessionId);
    }
    if (said) speech.say(said);
    speech.end();
    return turn?.asking && turn.open ? 'question' : 'report';
  }

  /** Speaks the turn into `speech` until it ends, asks a question (D4.7) or runs past the limit. */
  private async follow(c: { sessionId: string; locale: Locale }, turn: VoiceTurn, speech: Speech, gone: AbortSignal): Promise<VoiceTurnResult> {
    const t = tr(c.locale);
    const onGone = () => {
      turn.speech = null;
    };
    gone.addEventListener('abort', onGone, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const long = new Promise<VoiceTurnResult>(r => {
      timer = setTimeout(() => r('long'), this.o.maxTurnMs);
    });
    try {
      const r = await Promise.race([turn.finished, long, turn.asked()]);
      if (r === 'question') {
        // the turn waits for the answer in the map; the next utterance answers it
        void turn.finished.then(() => {
          if (this.turns.get(c.sessionId) === turn) this.turns.delete(c.sessionId);
        });
        return 'question';
      }
      if (r === 'long') {
        turn.detached = true;
        turn.release(t.text('hub.voiceTalk.long'));
        // the map keeps the turn until it ends: the next utterance is queued behind it, not interrupting it
        void turn.finished.then(r => {
          if (this.turns.get(c.sessionId) === turn) this.turns.delete(c.sessionId);
          const said = turn.unsaid.trim();
          if (turn.detached && r !== 'superseded' && said) this.reports.set(c.sessionId, said);
        });
        return 'long';
      }
      if (this.turns.get(c.sessionId) === turn) this.turns.delete(c.sessionId);
      if (r === 'ok' && gone.aborted) return 'client_closed';
      return r;
    } finally {
      clearTimeout(timer);
      gone.removeEventListener('abort', onGone);
      // the speech of a superseded turn was released by the next utterance; any other ends here
      if (!speech.ended && turn.speech === speech) speech.end();
    }
  }
}
