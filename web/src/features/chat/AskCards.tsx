/**
 * Cards for the two tools that ask the user instead of acting (Ivan, M4b: AskUserQuestion showed as a permission
 * card with raw JSON).
 * - QuestionCard (`AskUserQuestion`, permission kind 'question'): per question a header chip, the text, options as
 *   radio or checkbox cards with their descriptions, «(Recommended)» shown as a mark, «Свой ответ» (Other); one
 *   «Ответить» (enabled when every question has an answer) and «Не отвечать» (deny).
 * - PlanCard (`ExitPlanMode`, kind 'plan'): the plan as Markdown, «Утвердить план» and «Продолжить планирование» with a
 *   comment.
 * The answer goes as `POST …/permissions/:id {decision:'allow', answers}` or `{decision:'deny', message}`; a decision
 * from another window resolves the request and the card turns into a note (transcript.ts).
 */
import { useContext, useId, useState } from 'react';
import type { DecideExtra } from '../../api/client';
import type { PermissionDecision, PermissionView } from '../../api/types';
import { Markdown } from './Markdown';
import { AgentProvider } from './agentName';
import { PROVIDER_LABELS } from '../../api/types';
import { useUnsavedInput } from '../update/unsaved';

export interface AskOption {
  label: string;
  description?: string;
}
export interface AskQuestion {
  header?: string;
  question: string;
  options: AskOption[];
  multiSelect?: boolean;
}

/** 'question' | 'plan' | 'tool' — the hub's `kind`, or the tool name on an older hub. */
export function askKind(r: PermissionView): 'question' | 'plan' | 'tool' {
  const k = (r as PermissionView & { kind?: string }).kind;
  if (k === 'question' || r.toolName === 'AskUserQuestion') return 'question';
  if (k === 'plan' || r.toolName === 'ExitPlanMode') return 'plan';
  return 'tool';
}

export function questionsOf(r: PermissionView): AskQuestion[] {
  const raw = (r as PermissionView & { questions?: unknown }).questions ?? r.input?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(q => {
    if (!q || typeof q !== 'object') return [];
    const x = q as Record<string, unknown>;
    if (typeof x.question !== 'string') return [];
    const options = Array.isArray(x.options)
      ? x.options.flatMap(o =>
          o && typeof o === 'object' && typeof (o as AskOption).label === 'string'
            ? [{ label: (o as AskOption).label, description: typeof (o as AskOption).description === 'string' ? (o as AskOption).description : undefined }]
            : [],
        )
      : [];
    return [{ header: typeof x.header === 'string' ? x.header : undefined, question: x.question, options, multiSelect: x.multiSelect === true }];
  });
}

const RECOMMENDED = /\s*\((recommended|рекомендуется)\)\s*/i;
export const cleanLabel = (label: string) => label.replace(RECOMMENDED, ' ').trim();
export const isRecommended = (label: string) => RECOMMENDED.test(label);

/** The resolved note: «Вы ответили: …» from the answers the hub kept. */
export function answeredText(r: PermissionView): string {
  if (askKind(r) === 'plan') {
    if (r.decision === 'deny') return `План: продолжить планирование${r.message ? ` — ${r.message}` : ''}`;
    return 'План утверждён';
  }
  if (r.decision === 'deny') return 'Вопрос без ответа';
  // change `subagents` S10.2: «<вопрос> — <ответ>» per line, in the order of the questions
  const answers = (r as PermissionView & { answers?: Record<string, string | string[]> | null }).answers ?? (r.input?.answers as Record<string, string | string[]> | undefined) ?? {};
  const text = (v: string | string[] | undefined) => (Array.isArray(v) ? v.map(cleanLabel).join(', ') : v ? cleanLabel(v) : '');
  const qs = questionsOf(r);
  const pairs = qs.length ? qs.map(q => `${q.question} — ${text(answers[q.question]) || 'без ответа'}`) : Object.entries(answers).map(([q, v]) => `${q} — ${text(v)}`);
  return pairs.length ? `Вы ответили:\n${pairs.join('\n')}` : 'Вы ответили';
}

type Decide = (d: PermissionDecision, extra?: DecideExtra) => void;

export function QuestionCard({ request, disabled, onDecide }: { request: PermissionView; disabled: boolean; onDecide: Decide }) {
  const agent = PROVIDER_LABELS[useContext(AgentProvider)];
  const qs = questionsOf(request);
  const base = useId();
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  // client-versions D4: a started answer blocks a silent reload
  useUnsavedInput(!disabled && (Object.values(picked).some(l => l.length > 0) || Object.values(other).some(t => t.trim() !== '')));
  /** The hub's contract: the label for one choice, the labels for several, the own text for «Свой ответ». */
  const answerOf = (i: number): string | string[] => {
    const sel = picked[i] ?? [];
    const own = other[i]?.trim();
    if (qs[i]?.multiSelect) return [...sel, ...(own ? [own] : [])];
    return own || sel[0] || '';
  };
  const complete = qs.length > 0 && qs.every((_, i) => answerOf(i).length > 0);
  const toggle = (i: number, label: string, multi: boolean) =>
    setPicked(p => {
      const cur = p[i] ?? [];
      if (!multi) return { ...p, [i]: cur[0] === label ? [] : [label] };
      return { ...p, [i]: cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label] };
    });
  const submit = () => {
    if (!complete) return;
    onDecide('allow', { answers: Object.fromEntries(qs.map((q, i) => [q.question, answerOf(i)])) });
  };
  return (
    <div className="perm ask" role="group" aria-label={`${agent} задаёт вопрос`}>
      <div className="p-head">
        <span className="g-perm" aria-hidden="true">
          ?
        </span>
        {qs.length > 1 ? `${agent} задаёт ${qs.length} вопроса` : `${agent} задаёт вопрос`}
      </div>
      {qs.map((q, i) => {
        const name = `${base}-q${i}`;
        return (
          <fieldset key={i} className="ask-q" disabled={disabled}>
            <legend>
              {q.header && <span className="ask-chip">{q.header}</span>}
              <span className="ask-text">{q.question}</span>
              {q.multiSelect && <span className="ask-multi">можно несколько</span>}
            </legend>
            <div className="ask-opts">
              {q.options.map(o => {
                const on = (picked[i] ?? []).includes(o.label);
                const rec = isRecommended(o.label);
                return (
                  <label key={o.label} className={`ask-opt${on ? ' on' : ''}${rec ? ' rec' : ''}`}>
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={name}
                      checked={on}
                      onChange={() => toggle(i, o.label, !!q.multiSelect)}
                      onClick={() => !q.multiSelect && on && toggle(i, o.label, false)}
                    />
                    <span className="ask-body">
                      <b>
                        {cleanLabel(o.label)}
                        {rec && <span className="ask-rec">рекомендуется</span>}
                      </b>
                      {o.description && <span>{o.description}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
            <label className="ask-other">
              <span>Свой ответ</span>
              <input
                className="input"
                value={other[i] ?? ''}
                placeholder={q.multiSelect ? 'Добавить свой вариант' : 'Ответить своими словами'}
                onChange={e => setOther(o => ({ ...o, [i]: e.target.value }))}
              />
            </label>
          </fieldset>
        );
      })}
      <div className="p-actions">
        <button type="button" className="btn primary" disabled={disabled || !complete} title={complete ? undefined : 'Ответьте на каждый вопрос'} onClick={submit}>
          Ответить
        </button>
        <button type="button" className="btn" disabled={disabled} onClick={() => onDecide('deny')}>
          Не отвечать
        </button>
      </div>
    </div>
  );
}

export function PlanCard({ request, disabled, onDecide }: { request: PermissionView; disabled: boolean; onDecide: Decide }) {
  const agent = PROVIDER_LABELS[useContext(AgentProvider)];
  const plan = typeof request.input?.plan === 'string' ? request.input.plan : '';
  const [more, setMore] = useState(false);
  const [comment, setComment] = useState('');
  useUnsavedInput(!disabled && comment.trim() !== '');
  const id = useId();
  return (
    <div className="perm ask plan" role="group" aria-label={`План ${agent}`}>
      <div className="p-head">
        <span className="g-perm" aria-hidden="true">
          ✓
        </span>
        {agent} предлагает план
      </div>
      <div className="plan-body md">
        <Markdown text={plan || '_План пуст_'} />
      </div>
      {more && (
        <label className="ask-other" htmlFor={`${id}-c`}>
          <span>Что поправить в плане</span>
          <textarea id={`${id}-c`} className="input" value={comment} disabled={disabled} onChange={e => setComment(e.target.value)} autoFocus />
        </label>
      )}
      <div className="p-actions">
        <button type="button" className="btn primary" disabled={disabled} onClick={() => onDecide('allow')}>
          Утвердить план
        </button>
        {!more ? (
          <button type="button" className="btn" disabled={disabled} onClick={() => setMore(true)}>
            Продолжить планирование
          </button>
        ) : (
          <button type="button" className="btn" disabled={disabled} onClick={() => onDecide('deny', { message: comment.trim() || 'Продолжить планирование' })}>
            Отправить и продолжить планирование
          </button>
        )}
      </div>
    </div>
  );
}
