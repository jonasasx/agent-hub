/**
 * The project line under the chat head (H5 of UI review 2.15): a button with the area colour and the project name opens
 * a menu — «Перенести в…» (search over the directory: areas, systems, projects, clones, «Vault», «Знания», «Без
 * проекта»), «Закрепить» or «Открепить»; then the evidence, the second project as a label, the pin mark.
 * Requirements: workspace-ui «Строка проекта под шапкой чата»; project-grouping «Ручной перенос и закрепление».
 * API: GET /api/projects, PUT /api/sessions/:id/project, POST/DELETE /api/sessions/:id/pin (D10).
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { SessionView } from '../../api/types';
import { useStore } from '../../store';
import { useMenu } from '../ui/a11y';
import { colorVar } from '../sessions/status';
import { loadProjectDir, moveToProject, setPinned } from '../workspace/actions';
import { KIND_LABEL, evidenceText, filterProjects, secondaryProject, type ProjectInfo } from './projects';
import { useUnsavedInput } from '../update/unsaved';

const PIN = (
  <svg className="pin" viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
    <path d="M10.5 1.5 14.5 5.5 12.7 6.2 9.9 9 10.2 12.3 8.9 13.6 6.2 10.9 2.7 14.4 1.6 14.4 1.6 13.3 5.1 9.8 2.4 7.1 3.7 5.8 7 6.1 9.8 3.3Z" />
  </svg>
);

function Picker({ s, onDone }: { s: SessionView; onDone: () => void }) {
  const dir = useStore(st => st.projectDir);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  useUnsavedInput(q.trim() !== '');
  useEffect(() => {
    void loadProjectDir();
  }, []);
  const items = dir ? filterProjects(dir, q) : [];
  const cur = Math.min(sel, items.length - 1);
  const current = s.project.id ?? 'none';
  const pick = (id: string) => {
    onDone();
    if (id !== current || s.projectSource !== 'manual') void moveToProject(s.id, id);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(Math.min(items.length - 1, cur + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(0, cur - 1));
    } else if (e.key === 'Enter' && items[cur]) {
      e.preventDefault();
      pick(items[cur].id);
    }
  };
  return (
    <>
      <div className="m-title">Перенести в…</div>
      <input
        className="input proj-q"
        placeholder="Проект, система или область"
        aria-label="Найти проект"
        role="combobox"
        aria-expanded
        aria-controls={`proj-list-${s.id}`}
        aria-activedescendant={items[cur] ? `proj-${s.id}-${items[cur].id}` : undefined}
        value={q}
        onChange={e => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={onKey}
      />
      <div className="proj-list" id={`proj-list-${s.id}`} role="listbox" aria-label="Проекты">
        {!dir && <div className="hint">Загрузка…</div>}
        {dir && !items.length && <div className="hint">Ничего не найдено</div>}
        {items.map((p, i) => (
          <button
            key={p.id}
            id={`proj-${s.id}-${p.id}`}
            type="button"
            role="option"
            aria-selected={i === cur}
            className={`${i === cur ? 'sel' : ''}${p.id === current ? ' on' : ''}${p.archived ? ' archived' : ''}`}
            style={{ '--gc': colorVar(p.colorKey) } as CSSProperties}
            title={p.path || undefined}
            tabIndex={-1}
            onMouseEnter={() => setSel(i)}
            onClick={() => pick(p.id)}
          >
            <span className="sw" />
            <span className="p-name">{p.title}</span>
            <span className="p-kind">{p.archived ? 'архив' : KIND_LABEL[p.kind]}</span>
          </button>
        ))}
      </div>
    </>
  );
}

const AUTO_REASON: Record<string, string> = { cwd: 'рабочая папка', remote: 'Git remote', changed_files: 'изменённые файлы', unpinned: 'выбор без закрепления' };

/** `note` replaces the evidence on the phone (the state of the session), `noteTitle` is its whole text. */
export function ProjectLine({ s, note, noteTitle }: { s: SessionView; note?: string; noteTitle?: string }) {
  const [menu, setMenu] = useState<null | 'menu' | 'move'>(null);
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const close = () => {
    setMenu(null);
    btn.current?.focus();
  };
  useMenu(menu === 'menu', box, close);
  useMenu(menu === 'move', box, close);
  // useMenu focuses the first focusable of the box (the button itself): the first item or the search field instead
  useEffect(() => {
    if (menu) box.current?.querySelector<HTMLElement>(menu === 'menu' ? '[role="menuitem"]' : 'input')?.focus();
  }, [menu]);
  const project = s.project as ProjectInfo;
  const pinned = s.catalogProject ? s.catalogProjectSource !== 'auto' : s.projectSource === 'manual';
  const evidence =
    s.catalogProjectSource === 'auto'
      ? s.catalogProjectReason === 'classifier'
        ? 'Определено по первому сообщению'
        : `Автоматически: ${AUTO_REASON[s.catalogProjectReason ?? ''] ?? 'проект определён'}`
      : s.catalogProject
        ? 'закреплено вручную'
        : evidenceText(s);
  const second = secondaryProject(s);
  return (
    <>
      <span ref={box} className="proj-box">
        <button
          ref={btn}
          type="button"
          className={`pill gp proj-btn${project.archived ? ' archived' : ''}`}
          style={{ '--gc': colorVar(project.colorKey) } as CSSProperties}
          title={project.path || 'Проект не определён'}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          aria-label={`Проект: ${project.title}${pinned ? ', закреплён' : ''}`}
          onClick={() => setMenu(menu ? null : 'menu')}
        >
          <span className="pdot" />
          <span className="p-name">{project.title}</span>
          {pinned && PIN}
          <span className="caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {menu === 'menu' && (
          <div className="menu" role="menu" aria-label="Проект сессии">
            <button type="button" role="menuitem" onClick={() => setMenu('move')}>
              Перенести в…
            </button>
            {pinned ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  void setPinned(s.id, false);
                }}
              >
                Открепить
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  void setPinned(s.id, true);
                }}
              >
                Закрепить
              </button>
            )}
          </div>
        )}
        {menu === 'move' && (
          <div className="menu proj-menu" role="dialog" aria-label="Перенести в проект">
            <Picker s={s} onDone={close} />
          </div>
        )}
      </span>
      <span className="evidence" title={note ? `${noteTitle ?? note}\nПроект: ${evidence}` : evidence}>
        {note ?? evidence}
      </span>
      {!note && s.catalogProjectSource === 'auto' && (
        <button type="button" className="evidence-change" onClick={() => setMenu('move')}>
          изменить
        </button>
      )}
      {second && (
        <span className="pill gp sec" style={{ '--gc': colorVar(second.colorKey) } as CSSProperties} title={`Второй проект: ${second.path || second.title}`}>
          + {second.title}
        </span>
      )}
    </>
  );
}
