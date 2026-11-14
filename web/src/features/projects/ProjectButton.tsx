/**
 * The project line under the chat head (spec `session-project-line`, variant A of the project picker): one line instead of the
 * suggestion banner and the project button. The chip with the area colour opens one picker — «Предлагает хаб», «Недавние»,
 * «Все проекты», «Создать проект «запрос»», «Без проекта», «Закрепить»/«Открепить» and the note that the folder stays.
 * While the classifier is not sure the line shows «? Проект» with the options of the hub, «Другой…», «Без проекта» and «Позже».
 * Requirements: session-project-line; project-auto-detection «Назначение по уверенности и карточка выбора».
 * API: GET /api/projects, PUT /api/sessions/:id/project, POST/DELETE /api/sessions/:id/pin, POST …/project-suggestion.
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { ProjectSuggestionAnswer } from '@agent-hub/shared';
import type { SessionView } from '../../api/types';
import { api, ApiError } from '../../api/client';
import { useStore } from '../../store';
import { useMenu } from '../ui/a11y';
import { colorVar } from '../sessions/status';
import { confirmProject, loadProjectDir, moveWithUndo, setPinned } from '../workspace/actions';
import { hubText, t, useT } from '../../i18n';
import { kindLabel, evidenceText, filterProjects, secondaryProject, type ProjectInfo, type ProjectItem } from './projects';
import { useUnsavedInput } from '../update/unsaved';

const PIN = (
  <svg className="pin" viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
    <path d="M10.5 1.5 14.5 5.5 12.7 6.2 9.9 9 10.2 12.3 8.9 13.6 6.2 10.9 2.7 14.4 1.6 14.4 1.6 13.3 5.1 9.8 2.4 7.1 3.7 5.8 7 6.1 9.8 3.3Z" />
  </svg>
);

const RECENT = 3;

interface Row {
  key: string;
  kind: 'project' | 'create' | 'none';
  id: string;
  title: string;
  colorKey: ProjectItem['colorKey'];
  path: string;
  tag: string;
  archived: boolean;
}

interface Section {
  title: string | null;
  rows: Row[];
}

const projectRow = (p: ProjectItem, prefix: string): Row => ({
  key: `${prefix}:${p.id}`,
  kind: 'project',
  id: p.id,
  title: p.title,
  colorKey: p.colorKey,
  path: p.path,
  tag: p.archived ? t('projects.line.archived') : kindLabel(p.kind),
  archived: p.archived,
});

const at = (x: SessionView): number => Date.parse(x.lastEventAt ?? '') || 0;

/** Projects the user's other sessions are in, the most recently active first, without the current one and «Без проекта». */
function recentIds(sessions: Record<string, SessionView>, current: string): string[] {
  const ids: string[] = [];
  const list = Object.values(sessions).sort((a, b) => at(b) - at(a));
  for (const s of list) {
    const id = s.project.id;
    if (id && id !== current && !ids.includes(id)) ids.push(id);
    if (ids.length === RECENT) break;
  }
  return ids;
}

function Picker({ s, pinned, hubOptions, onDone }: { s: SessionView; pinned: boolean; hubOptions: { projectId: string; name: string }[]; onDone: () => void }) {
  const tr = useT();
  const dir = useStore(st => st.projectDir);
  const sessions = useStore(st => st.sessions);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useUnsavedInput(q.trim() !== '');
  useEffect(() => {
    void loadProjectDir();
  }, []);
  const current = s.project.id ?? 'none';
  const query = q.trim();
  const real = (dir ?? []).filter(p => p.id !== 'none');
  const byId = new Map(real.map(p => [p.id, p]));
  const sections: Section[] = [];
  if (dir && !query) {
    const hub = hubOptions.flatMap(o => (byId.has(o.projectId) ? [projectRow(byId.get(o.projectId)!, 'hub')] : []));
    if (hub.length) sections.push({ title: tr('projects.pick.hub'), rows: hub });
    const recent = recentIds(sessions, current).flatMap(id => (byId.has(id) ? [projectRow(byId.get(id)!, 'recent')] : []));
    if (recent.length) sections.push({ title: tr('projects.pick.recent'), rows: recent });
    sections.push({ title: tr('projects.pick.all', { n: real.length }), rows: real.map(p => projectRow(p, 'all')) });
  } else if (dir) {
    const found = filterProjects(real, query).map(p => projectRow(p, 'found'));
    sections.push({ title: found.length ? tr('projects.pick.found') : null, rows: found });
  }
  const tail: Row[] = [];
  if (dir && query && !real.some(p => p.title.toLowerCase() === query.toLowerCase())) {
    tail.push({ key: 'create', kind: 'create', id: query, title: tr('projects.suggest.createNamed', { name: query }), colorKey: 'none', path: '', tag: '', archived: false });
  }
  if (dir) {
    tail.push({ key: 'none', kind: 'none', id: 'none', title: tr('projects.none'), colorKey: 'none', path: '', tag: '', archived: false });
  }
  if (tail.length) sections.push({ title: null, rows: tail });
  const rows = sections.flatMap(x => x.rows);
  const cur = Math.min(sel, rows.length - 1);
  const pick = async (row: Row) => {
    setError(null);
    if (row.kind === 'create') {
      try {
        const created = await api.createCatalogProject({ name: row.id });
        onDone();
        await moveWithUndo(s, created.id, created.name, pinned);
      } catch (err) {
        setError(err instanceof ApiError && err.code === 'name_conflict' ? tr('projects.suggest.taken') : tr('projects.suggest.saveFailed'));
      }
      return;
    }
    onDone();
    if (row.id !== current || !pinned) await moveWithUndo(s, row.id, row.title, pinned);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(Math.min(rows.length - 1, cur + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(0, cur - 1));
    } else if (e.key === 'Enter' && rows[cur]) {
      e.preventDefault();
      void pick(rows[cur]);
    }
  };
  let at = -1;
  return (
    <>
      <input
        className="input proj-q"
        placeholder={tr('projects.line.search')}
        aria-label={tr('projects.line.searchLabel')}
        role="combobox"
        aria-expanded
        aria-controls={`proj-list-${s.id}`}
        aria-activedescendant={rows[cur] ? `proj-${s.id}-${rows[cur].key}` : undefined}
        value={q}
        onChange={e => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={onKey}
      />
      <div className="proj-list" id={`proj-list-${s.id}`} role="listbox" aria-label={tr('projects.line.list')}>
        {!dir && <div className="hint">{tr('projects.line.loading')}</div>}
        {dir && !rows.length && <div className="hint">{tr('projects.line.nothing')}</div>}
        {sections.map((section, n) => (
          <div key={n} className="proj-sec" role="group" aria-label={section.title ?? undefined}>
            {section.title && <div className="m-title">{section.title}</div>}
            {section.rows.map(row => {
              const i = ++at;
              return (
                <button
                  key={row.key}
                  id={`proj-${s.id}-${row.key}`}
                  type="button"
                  role="option"
                  aria-selected={i === cur}
                  className={`${i === cur ? 'sel' : ''}${row.id === current && row.kind === 'project' ? ' on' : ''}${row.archived ? ' archived' : ''}${row.kind === 'create' ? ' create' : ''}`}
                  style={{ '--gc': colorVar(row.colorKey) } as CSSProperties}
                  title={row.path || undefined}
                  tabIndex={-1}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => void pick(row)}
                >
                  <span className="sw" />
                  <span className="p-name">{row.title}</span>
                  <span className="p-kind">{row.tag}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {error && (
        <div className="hint" role="alert">
          {error}
        </div>
      )}
      <div className="proj-foot">
        <button
          type="button"
          className="btn"
          onClick={() => {
            onDone();
            void setPinned(s.id, !pinned);
          }}
        >
          {pinned ? tr('projects.line.unpin') : tr('projects.line.pin')}
        </button>
        <span className="hint">{tr('projects.line.folderNote')}</span>
      </div>
    </>
  );
}

const AUTO_REASONS = {
  cwd: 'projects.reason.cwd',
  remote: 'projects.reason.remote',
  changed_files: 'projects.reason.changed_files',
  unpinned: 'projects.reason.unpinned',
  inherited: 'projects.reason.inherited',
} as const;

/** The questions of the hub in the line: its options, a new project, «Без проекта», «Позже» (spec «Хаб не уверен»). */
function AskControls({ s, onCatalog }: { s: SessionView; onCatalog: () => void }) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const suggestion = s.projectSuggestion;
  if (!suggestion || s.catalogProject || hidden === suggestion.inputHash) return null;
  const options = suggestion.options ?? [];
  const proposed = suggestion.newProjectName ?? '';
  const answer = async (body: ProjectSuggestionAnswer) => {
    setBusy(true);
    setError(null);
    try {
      await api.answerProjectSuggestion(s.id, body);
      setHidden(suggestion.inputHash);
    } catch (err) {
      const taken = err instanceof ApiError && err.code === 'name_conflict';
      setError(taken ? t('projects.suggest.taken') : t('projects.suggest.saveFailed'));
    } finally {
      setBusy(false);
    }
  };
  const create = () => {
    const value = (editing ? name : proposed).trim();
    if (value) void answer({ action: 'create', name: value, inputHash: suggestion.inputHash });
  };
  return (
    <div className="proj-ask" role="status">
      <span className="sr-only">
        {options.length ? tr('projects.suggest.unsure') : tr('projects.suggest.none')}
        {error && <span role="alert"> {error}</span>}
      </span>
      {options.map(o => (
        <button
          key={o.projectId}
          type="button"
          className="btn project-suggestion-option"
          disabled={busy}
          onClick={() => void answer({ action: 'accept', projectId: o.projectId, inputHash: suggestion.inputHash })}
        >
          <span className="pdot" aria-hidden="true" style={{ background: colorVar(o.colorKey) }} />
          {o.name}
        </button>
      ))}
      {editing ? (
        <form
          className="project-suggestion-create"
          onSubmit={event => {
            event.preventDefault();
            create();
          }}
        >
          <input className="input" aria-label={tr('projects.suggest.nameLabel')} value={name} maxLength={120} autoFocus onChange={event => setName(event.target.value)} />
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            {tr('projects.suggest.create')}
          </button>
        </form>
      ) : (
        <>
          {proposed && (
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              title={tr('projects.suggest.createNamed', { name: proposed })}
              aria-label={tr('projects.suggest.createNamed', { name: proposed })}
              onClick={create}
            >
              <span className="btn-label">+ {proposed}</span>
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setName(proposed);
              setEditing(true);
            }}
          >
            {proposed ? tr('projects.suggest.otherName') : tr('projects.suggest.newProject')}
          </button>
        </>
      )}
      <button type="button" className="btn" disabled={busy} onClick={onCatalog}>
        {options.length ? tr('projects.line.other') : tr('projects.pick.fromCatalog')}
      </button>
      <button type="button" className="btn" disabled={busy} onClick={() => void answer({ action: 'dismiss', inputHash: suggestion.inputHash })}>
        {tr('projects.none')}
      </button>
      <button type="button" className="btn" disabled={busy} onClick={() => setHidden(suggestion.inputHash)}>
        {tr('projects.line.later')}
      </button>
    </div>
  );
}

/** `note` replaces the evidence on the phone (the state of the session), `noteTitle` is its whole text. */
export function ProjectLine({ s, note, noteTitle }: { s: SessionView; note?: string; noteTitle?: string }) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  useMenu(open, box, close);
  // useMenu focuses the first focusable of the box (the chip itself): the search field instead
  useEffect(() => {
    if (open) box.current?.querySelector<HTMLElement>('input')?.focus();
  }, [open]);
  const project = s.project as ProjectInfo;
  const projectName = hubText(project.title, project.i18n);
  const pinned = s.catalogProject ? s.catalogProjectSource !== 'auto' : s.projectSource === 'manual';
  const asking = !!s.projectSuggestion && !s.catalogProject;
  const auto = s.catalogProjectSource === 'auto';
  const evidence = auto
    ? s.catalogProjectReason === 'classifier'
      ? tr('projects.reason.classifier')
      : tr('projects.reason.auto', { reason: tr(AUTO_REASONS[(s.catalogProjectReason ?? '') as keyof typeof AUTO_REASONS] ?? 'projects.reason.unknown') })
    : s.catalogProject
      ? tr('projects.evidence.manual')
      : evidenceText(s);
  const second = secondaryProject(s);
  const hubOptions = asking ? (s.projectSuggestion?.options ?? []).map(o => ({ projectId: o.projectId, name: o.name })) : [];
  return (
    <>
      <span ref={box} className="proj-box">
        <button
          ref={btn}
          type="button"
          className={`pill gp proj-btn${project.archived ? ' archived' : ''}${asking ? ' asking' : ''}`}
          style={{ '--gc': colorVar(asking ? 'none' : project.colorKey) } as CSSProperties}
          title={project.path || tr('projects.line.notDetected')}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={asking ? tr('projects.line.askLabel') : pinned ? tr('projects.line.labelPinned', { name: projectName }) : tr('projects.line.label', { name: projectName })}
          onClick={() => setOpen(!open)}
        >
          <span className="pdot" />
          <span className="p-name">{asking ? tr('projects.line.askChip') : projectName}</span>
          {pinned && PIN}
          <span className="caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {open && (
          <>
            <div className="proj-backdrop" aria-hidden="true" onClick={close} />
            <div className="menu proj-menu" role="dialog" aria-label={tr('projects.line.moveDialog')}>
              <Picker s={s} pinned={pinned} hubOptions={hubOptions} onDone={close} />
            </div>
          </>
        )}
      </span>
      {!asking && (
        <span className="evidence" title={note ? `${noteTitle ?? note}\n${tr('projects.line.evidenceTitle', { evidence })}` : evidence}>
          {note ?? evidence}
        </span>
      )}
      {!asking && !note && project.archived && (
        <>
          <span className="evidence archived-note">{tr('projects.line.archivedNote')}</span>
          <button type="button" className="evidence-change" onClick={() => setOpen(true)}>
            {tr('projects.line.chooseOther')}
          </button>
        </>
      )}
      {!asking && !note && auto && !project.archived && (
        <button type="button" className="evidence-change" onClick={() => void confirmProject(s)}>
          {tr('projects.line.verify')}
        </button>
      )}
      {second && (
        <span className="pill gp sec" style={{ '--gc': colorVar(second.colorKey) } as CSSProperties} title={tr('projects.line.second', { name: second.path || second.title })}>
          + {second.title}
        </span>
      )}
      {asking && <AskControls s={s} onCatalog={() => setOpen(true)} />}
    </>
  );
}
