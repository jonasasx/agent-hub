// AskUserQuestion and ExitPlanMode cards (M4b): parsing, the recommended mark, the resolved note.
import { describe, expect, it } from 'vitest';
import type { PermissionView } from '../../api/types';
import { answeredText, askKind, cleanLabel, isRecommended, questionsOf } from './AskCards';
import { buildChat } from './transcript';

const req = (over: Partial<PermissionView> & Record<string, unknown>): PermissionView =>
  ({ requestId: 'r1', sessionId: 's', toolName: 'AskUserQuestion', toolUseId: 't', input: {}, createdAt: '', resolvedAt: null, decision: null, message: null, ...over }) as PermissionView;

describe('ask cards', () => {
  it('kind by the hub or by the tool name; questions parsed, junk dropped', () => {
    expect(askKind(req({}))).toBe('question');
    expect(askKind(req({ toolName: 'ExitPlanMode' }))).toBe('plan');
    expect(askKind(req({ toolName: 'Bash' }))).toBe('tool');
    expect(askKind(req({ toolName: 'X', kind: 'question' }))).toBe('question');
    const qs = questionsOf(req({ input: { questions: [{ header: 'H', question: 'Q?', multiSelect: true, options: [{ label: 'A', description: 'd' }, { nope: 1 }] }, { bad: true }] } }));
    expect(qs).toEqual([{ header: 'H', question: 'Q?', multiSelect: true, options: [{ label: 'A', description: 'd' }] }]);
  });
  it('«(Recommended)» becomes a mark, not text', () => {
    expect(isRecommended('Postgres (Recommended)')).toBe(true);
    expect(cleanLabel('Postgres (Recommended)')).toBe('Postgres');
    expect(isRecommended('Postgres')).toBe(false);
  });
  it('a resolved request becomes a note: answers, a skipped question, a plan', () => {
    // S10.2: pairs in the order of the questions, whatever the order of the keys; a question without an answer says so
    const three = {
      input: {
        questions: [
          { question: 'База?', options: [] },
          { question: 'Проверки?', options: [] },
          { question: 'Имя?', options: [] },
        ],
      },
    };
    expect(answeredText(req({ ...three, decision: 'allow', resolvedAt: 'x', answers: { 'Имя?': 'money', 'База?': 'Postgres (Recommended)', 'Проверки?': 'e2e, юнит' } }))).toBe(`Вы ответили:
База? — Postgres
Проверки? — e2e, юнит
Имя? — money`);
    expect(answeredText(req({ ...three, decision: 'allow', resolvedAt: 'x', answers: { 'База?': 'SQLite' } }))).toBe(`Вы ответили:
База? — SQLite
Проверки? — без ответа
Имя? — без ответа`);
    expect(answeredText(req({ decision: 'deny', resolvedAt: 'x' }))).toBe('Вопрос без ответа');
    expect(answeredText(req({ toolName: 'ExitPlanMode', decision: 'allow', resolvedAt: 'x' }))).toBe('План утверждён');
    expect(answeredText(req({ toolName: 'ExitPlanMode', decision: 'deny', resolvedAt: 'x', message: 'сначала тесты' }))).toBe('План: продолжить планирование — сначала тесты');
    const items = buildChat([{ kind: 'permission', id: 'p:r1', ts: '', request: req({ decision: 'allow', resolvedAt: 'x', answers: { q: 'A' } }) } as never]);
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'note',
        text: `Вы ответили:
q — A`,
      }),
    ]);
  });
});
