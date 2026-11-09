import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PROJECT_COLORS } from '@agent-hub/shared';
import type { ProjectRef, UserProjectView } from '../../api/types';
import { api, ApiError } from '../../api/client';
import { t, useT } from '../../i18n';
import { usableRunner, useStore } from '../../store';
import { useDialog, useMenu, useMenuPlacement } from '../ui/a11y';
import { loadSidebar } from '../workspace/actions';
import { ProjectPalette } from './ProjectPalette';
import { ProjectFolderField, folderInvalid } from './ProjectFolderField';

export function projectError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return t('projects.err.nameUsed');
    if (error.status === 404) return t('projects.err.notFound');
    if (error.status === 400) return t('projects.err.badRequest');
  }
  return t('projects.err.generic');
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
  const tr = useT();
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
        projectToast(t('projects.toast.notFound'), t('projects.toast.listUpdated'));
        await refreshProject(project.id!);
        focusSidebar();
        return;
      }
      setItem(found);
    } catch {
      setDialog(null);
      projectToast(t('projects.toast.notLoaded'), t('projects.toast.checkConnection'));
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
      projectToast(t('projects.toast.hidden'), project.title, {
        label: t('projects.toast.undo'),
        run: () => {
          void api
            .hideProjectGroup(project.id!, false)
            .then(() => refreshProject(project.id!))
            .catch(error => projectToast(t('projects.toast.notRestored'), projectError(error)));
        },
      });
    } catch (error) {
      projectToast(t('projects.toast.notHidden'), projectError(error));
    }
  }
  async function color(value: UserProjectView['colorKey']) {
    setMenu(false);
    try {
      if (project.path) await api.patchProjectGroupColor(project.id!, value);
      else await api.patchCatalogProject(project.id!, { colorKey: value });
      await refreshProject(project.id!);
    } catch (error) {
      projectToast(t('projects.toast.colorFailed'), projectError(error));
    } finally {
      menuRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();
    }
  }
  return (
    <div className="project-actions" ref={menuRef}>
      <button type="button" className="icon-btn" aria-label={tr('projects.actions.label', { title: project.title })} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
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
              {tr('projects.actions.edit')}
            </button>
          )}
          <button type="button" className={project.path ? '' : 'danger'} role="menuitem" onClick={() => (project.path ? void hide() : void open('delete'))}>
            {project.path ? tr('projects.actions.hide') : tr('projects.actions.delete')}
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
  const tr = useT();
  const ref = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useDialog(ref, onClose, close);
  return createPortal(
    <div className="scrim">
      <section className="modal project-editor" role="dialog" aria-modal="true" aria-label={tr('projects.actions.loadingTitle')} ref={ref}>
        <header className="modal-head">
          <h2>{tr('projects.actions.loadingTitle')}</h2>
          <button className="icon-btn" type="button" aria-label={tr('projects.dialog.close')} ref={close} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body" role="status">
          <span className="spinner" /> {tr('projects.actions.loadingText')}
        </div>
      </section>
    </div>,
    document.body,
  );
}
function ProjectDialog({ project, item, mode, total, onClose }: { project: ProjectRef; item: UserProjectView; mode: 'edit' | 'delete'; total: number; onClose: () => void }) {
  const tr = useT();
  // session-folder D7: the picker and the hint use the first online machine
  const runner = useStore(s => s.runners.filter(usableRunner).find(r => r.online));
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [remote, setRemote] = useState(item.remote ?? '');
  const [color, setColor] = useState(item.colorKey);
  const [folder, setFolder] = useState(item.folder ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nameInvalid, setNameInvalid] = useState(false);
  const [folderError, setFolderError] = useState<string | undefined>(undefined);
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
      setError(t('projects.new.nameRequired'));
      setNameInvalid(true);
      nameRef.current?.focus();
      return;
    }
    if (mode === 'edit' && folderInvalid(folder)) return;
    setBusy(true);
    setError('');
    setNameInvalid(false);
    setFolderError(undefined);
    try {
      if (mode === 'delete') await api.deleteCatalogProject(item.id);
      else
        await api.patchCatalogProject(item.id, {
          name: name.trim(),
          colorKey: color,
          description,
          remote: remote.trim() || null,
          folder: folder.trim() || null,
        });
    } catch (failure) {
      setError(projectError(failure));
      const invalidName = failure instanceof ApiError && failure.status === 409;
      setNameInvalid(invalidName);
      if (invalidName) setTimeout(() => nameRef.current?.focus(), 0);
      if (failure instanceof ApiError && failure.status === 400) setFolderError(projectError(failure));
      setBusy(false);
      return;
    }
    onClose();
    await refreshProject(project.id!);
    if (mode === 'delete') focusSidebar();
  }
  return createPortal(
    <div className="scrim" role="presentation">
      <section className="modal project-editor" role="dialog" aria-modal="true" aria-busy={busy} aria-label={mode === 'edit' ? tr('projects.actions.edit') : tr('projects.actions.delete')} ref={ref}>
        <header className="modal-head">
          <h2>{mode === 'edit' ? tr('projects.actions.edit') : tr('projects.actions.delete')}</h2>
          <button type="button" className="icon-btn" aria-label={tr('projects.dialog.close')} disabled={busy} onClick={onClose}>
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
                <p>{tr('projects.dialog.confirm', { title: project.title })}</p>
                <p>{tr('projects.dialog.kept', { count: total })}</p>
                <ul className="project-consequences">
                  <li>{tr('projects.dialog.keepItem', { count: total })}</li>
                  <li>{tr('projects.dialog.removeItem')}</li>
                </ul>
                <p>{tr('projects.dialog.moveBack')}</p>
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="project-name">{tr('projects.dialog.name')}</label>
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
                  <legend>{tr('projects.palette.label')}</legend>
                  <ProjectPalette value={color} onChange={setColor} />
                </fieldset>
                <label className="field">
                  {tr('projects.dialog.description')}
                  <textarea className="input" maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} />
                </label>
                <label className="field">
                  {tr('projects.dialog.remote')}
                  <input className="input" maxLength={2000} value={remote} onChange={event => setRemote(event.target.value)} />
                </label>
                <ProjectFolderField id="project-folder" value={folder} runner={runner} error={folderError} onChange={setFolder} />
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
              {tr('projects.dialog.cancel')}
            </button>
            <button className={`btn ${mode === 'delete' ? 'danger' : 'primary'}`} type="submit" disabled={busy}>
              {busy ? tr('projects.dialog.saving') : mode === 'delete' ? tr('projects.actions.delete') : tr('projects.dialog.save')}
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  );
}
