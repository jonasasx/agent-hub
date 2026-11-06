import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PROJECT_COLORS } from '@agent-hub/shared';
import type { ProjectRef, UserProjectView } from '../../api/types';
import { api, ApiError } from '../../api/client';
import { useStore } from '../../store';
import { useDialog, useMenu, useMenuPlacement } from '../ui/a11y';
import { loadSidebar } from '../workspace/actions';
import { FolderPicker } from '../newSession/FolderPicker';
import { ProjectPalette } from './ProjectPalette';

export function projectError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'binding_conflict') return 'Папка уже привязана к другому проекту';
    if (error.status === 409) return 'Название проекта уже используется';
    if (error.status === 404) return 'Проект или машина не найдены';
    if (error.status === 400) return 'Проверьте название и абсолютные пути папок';
  }
  return 'Не удалось сохранить изменения. Проверьте связь и попробуйте ещё раз';
}
export function projectToast(title: string, text: string, action?: { label: string; run: () => void }) {
  useStore.getState().pushToast({ title, text, ...(action ? { action } : {}) });
}
export async function refreshProject(id: string) {
  const cached = Object.values(useStore.getState().sessions).filter(s => s.project.id === id);
  try {
    await loadSidebar();
    const refreshed = await Promise.all(cached.map(s => api.session(s.id)));
    useStore.getState().upsertSessions(refreshed);
  } catch (error) {
    console.warn('Не удалось обновить список проектов', error);
  }
}
export function focusSidebar() {
  setTimeout(() => document.getElementById('sidebar-projects-heading')?.focus(), 0);
}
export function ProjectActions({ project, total }: { project: ProjectRef; total: number }) {
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null);
  const [item, setItem] = useState<UserProjectView | null>(null);
  const [loading, setLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  useMenu(menu, menuRef, () => setMenu(false));
  const placement = useMenuPlacement(menu, menuRef, popup);
  async function open(mode: 'edit' | 'delete') {
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();
    setMenu(false);
    setLoading(true);
    setDialog(mode);
    setItem(null);
    try {
      const found = (await api.catalogProjects('recent', true)).find(p => p.id === project.id);
      if (!found) {
        setDialog(null);
        projectToast('Проект не найден', 'Список проектов обновлён');
        await refreshProject(project.id!);
        focusSidebar();
        return;
      }
      setItem(found);
    } catch {
      setDialog(null);
      projectToast('Проект не загружен', 'Проверьте связь и попробуйте ещё раз');
    } finally {
      setLoading(false);
    }
  }
  async function hide() {
    setMenu(false);
    try {
      await api.hideProjectGroup(project.id!, true);
      await refreshProject(project.id!);
      focusSidebar();
      projectToast('Скрыто', project.title, {
        label: 'Отменить',
        run: () => {
          void api
            .hideProjectGroup(project.id!, false)
            .then(() => refreshProject(project.id!))
            .catch(error => projectToast('Группа не возвращена', projectError(error)));
        },
      });
    } catch (error) {
      projectToast('Группа не скрыта', projectError(error));
    }
  }
  async function color(value: UserProjectView['colorKey']) {
    setMenu(false);
    try {
      if (project.path) await api.patchProjectGroupColor(project.id!, value);
      else await api.patchCatalogProject(project.id!, { colorKey: value });
      await refreshProject(project.id!);
    } catch (error) {
      projectToast('Цвет не изменён', projectError(error));
    } finally {
      menuRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();
    }
  }
  return (
    <div className="project-actions" ref={menuRef}>
      <button type="button" className="icon-btn" aria-label={`Действия проекта ${project.title}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
        ⋯
      </button>
      {menu && (
        <div ref={popup} className={`project-menu ${placement}`} role="menu">
          <div className="project-menu-colors">
            <ProjectPalette
              value={PROJECT_COLORS.includes(project.colorKey as UserProjectView['colorKey']) ? (project.colorKey as UserProjectView['colorKey']) : PROJECT_COLORS[0]}
              onChange={value => void color(value)}
            />
          </div>
          {!project.path && (
            <button type="button" role="menuitem" onClick={() => void open('edit')}>
              Изменить проект
            </button>
          )}
          <button type="button" className={project.path ? '' : 'danger'} role="menuitem" onClick={() => (project.path ? void hide() : void open('delete'))}>
            {project.path ? 'Скрыть группу' : 'Удалить проект'}
          </button>
        </div>
      )}
      {dialog &&
        (loading ? (
          <LoadingProject onClose={() => setDialog(null)} />
        ) : (
          item && <ProjectDialog key={`${project.id}-${dialog}`} project={project} item={item} mode={dialog} total={item.sessionCount ?? total} onClose={() => setDialog(null)} />
        ))}
    </div>
  );
}
function LoadingProject({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useDialog(ref, onClose, close);
  return createPortal(
    <div className="scrim">
      <section className="modal project-editor" role="dialog" aria-modal="true" aria-label="Загрузка проекта" ref={ref}>
        <header className="modal-head">
          <h2>Загрузка проекта</h2>
          <button className="icon-btn" type="button" aria-label="Закрыть" ref={close} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body" role="status">
          <span className="spinner" /> Загружаются данные и привязки…
        </div>
      </section>
    </div>,
    document.body,
  );
}
function ProjectDialog({ project, item, mode, total, onClose }: { project: ProjectRef; item: UserProjectView; mode: 'edit' | 'delete'; total: number; onClose: () => void }) {
  const runners = useStore(s => s.runners);
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [remote, setRemote] = useState(item.remote ?? '');
  const [color, setColor] = useState(item.colorKey);
  const [paths, setPaths] = useState<Record<string, string>>(Object.fromEntries(item.bindings.map(b => [b.runnerId, b.path])));
  const [picker, setPicker] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nameInvalid, setNameInvalid] = useState(false);
  const [bindingInvalid, setBindingInvalid] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useDialog(
    ref,
    () => {
      if (!busy) onClose();
    },
    mode === 'edit' ? nameRef : cancelRef,
  );
  async function submit() {
    if (mode === 'edit' && !name.trim()) {
      setError('Введите название проекта');
      setNameInvalid(true);
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setError('');
    setNameInvalid(false);
    setBindingInvalid(false);
    try {
      if (mode === 'delete') await api.deleteCatalogProject(item.id);
      else
        await api.patchCatalogProject(item.id, {
          name: name.trim(),
          colorKey: color,
          description,
          remote: remote.trim() || null,
          bindings: Object.entries(paths)
            .filter(([id, path]) => path.trim() !== (item.bindings.find(b => b.runnerId === id)?.path ?? ''))
            .map(([runnerId, path]) => ({ runnerId, path: path.trim() || null })),
        });
    } catch (failure) {
      setError(projectError(failure));
      const invalidName = failure instanceof ApiError && failure.status === 409 && failure.code !== 'binding_conflict';
      setNameInvalid(invalidName);
      if (invalidName) setTimeout(() => nameRef.current?.focus(), 0);
      setBindingInvalid(failure instanceof ApiError && (failure.code === 'binding_conflict' || failure.status === 400));
      setBusy(false);
      return;
    }
    onClose();
    await refreshProject(project.id!);
    if (mode === 'delete') focusSidebar();
  }
  return createPortal(
    <div className="scrim" role="presentation">
      <section
        className="modal project-editor"
        role="dialog"
        aria-modal="true"
        aria-hidden={picker !== null}
        aria-busy={busy}
        aria-label={mode === 'edit' ? 'Изменить проект' : 'Удалить проект'}
        ref={ref}
      >
        <header className="modal-head">
          <h2>{mode === 'edit' ? 'Изменить проект' : 'Удалить проект'}</h2>
          <button type="button" className="icon-btn" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        <form
          noValidate
          onSubmit={event => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="modal-body" inert={busy}>
            {mode === 'delete' ? (
              <>
                <p>Удалить «{project.title}»?</p>
                <p>Сессии ({total}), сообщения и транскрипты сохранятся.</p>
                <ul className="project-consequences">
                  <li>Останется: сессии ({total}) и транскрипты</li>
                  <li>Будет удалено: проект и привязки к папкам</li>
                </ul>
                <p>Сессии вернутся в автоматические группы или в «Без проекта».</p>
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="project-name">Название</label>
                  <input
                    id="project-name"
                    ref={nameRef}
                    className="input"
                    required
                    maxLength={120}
                    value={name}
                    aria-invalid={nameInvalid}
                    aria-describedby={nameInvalid ? 'project-name-error' : error ? 'project-edit-error' : undefined}
                    onChange={event => {
                      setName(event.target.value);
                      if (nameInvalid) setError('');
                      setNameInvalid(false);
                    }}
                  />
                  {nameInvalid && (
                    <span id="project-name-error" role="alert" className="field-error">
                      {error}
                    </span>
                  )}
                </div>
                <fieldset>
                  <legend>Цвет проекта</legend>
                  <ProjectPalette value={color} onChange={setColor} />
                </fieldset>
                <label className="field">
                  Описание
                  <textarea className="input" maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} />
                </label>
                <label className="field">
                  Remote Git
                  <input className="input" maxLength={2000} value={remote} onChange={event => setRemote(event.target.value)} />
                </label>
                <fieldset>
                  <legend>Папки на машинах</legend>
                  {Array.from(new Set([...runners.map(r => r.id), ...Object.keys(paths)])).map(id => (
                    <div className="project-binding" key={id}>
                      <label htmlFor={`binding-${id}`}>{runners.find(r => r.id === id)?.name ?? id}</label>
                      <div className="folder-path-row">
                        <input
                          id={`binding-${id}`}
                          className="input mono"
                          aria-invalid={bindingInvalid}
                          aria-describedby={bindingInvalid ? 'project-edit-error' : undefined}
                          value={paths[id] ?? ''}
                          onChange={event => setPaths({ ...paths, [id]: event.target.value })}
                        />
                        <button type="button" className="btn" disabled={!runners.find(r => r.id === id)?.online} onClick={() => setPicker(id)}>
                          Выбрать…
                        </button>
                        {paths[id] && (
                          <button type="button" className="btn" aria-label={`Убрать привязку ${id}`} onClick={() => setPaths({ ...paths, [id]: '' })}>
                            Убрать
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </fieldset>
              </>
            )}
          </div>
          <footer className="modal-foot">
            {error && !nameInvalid && (
              <p id="project-edit-error" role="alert" className="field-error">
                {error}
              </p>
            )}
            <button ref={cancelRef} type="button" className="btn" disabled={busy} onClick={onClose}>
              Отмена
            </button>
            <button className={`btn ${mode === 'delete' ? 'danger' : 'primary'}`} type="submit" disabled={busy}>
              {busy ? 'Сохранение…' : mode === 'delete' ? 'Удалить проект' : 'Сохранить'}
            </button>
          </footer>
        </form>
      </section>
      {picker && <FolderPicker runnerId={picker} initialPath={paths[picker] ?? ''} onChoose={path => setPaths({ ...paths, [picker]: path })} onClose={() => setPicker(null)} />}
    </div>,
    document.body,
  );
}
