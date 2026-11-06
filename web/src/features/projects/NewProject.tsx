import { useEffect, useRef, useState } from 'react';
import { allocateProjectColor } from '@agent-hub/shared';
import { createPortal } from 'react-dom';
import type { UserProjectView } from '../../api/types';
import { api, ApiError } from '../../api/client';
import { useDialog } from '../ui/a11y';
import { loadSidebar } from '../workspace/actions';
import { ProjectPalette } from './ProjectPalette';
import { projectError, projectToast } from './ProjectActions';

/** «+ проект» in the heading of the sidebar tree: an empty project of the catalog with a name, colour and description. */
export function NewProjectButton() {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btn} type="button" aria-label="Новый проект" title="Новый проект" onClick={() => setOpen(true)}>
        + проект
      </button>
      {open && (
        <NewProjectDialog
          onClose={() => {
            setOpen(false);
            btn.current?.focus();
          }}
        />
      )}
    </>
  );
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState<UserProjectView['colorKey']>('scanner');
  const picked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // the colour the hub would allocate: the least used one in the catalog
  useEffect(() => {
    let live = true;
    api
      .catalogProjects()
      .then(list => {
        if (live) setColor(current => (picked.current ? current : allocateProjectColor(list.map(p => p.colorKey))));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  useDialog(
    ref,
    () => {
      if (!busy) onClose();
    },
    nameRef,
  );
  async function submit() {
    if (!name.trim()) {
      setError('Введите название проекта');
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.createCatalogProject({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), colorKey: color });
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 409 ? 'Проект с таким названием уже есть' : projectError(failure));
      setBusy(false);
      setTimeout(() => nameRef.current?.focus(), 0);
      return;
    }
    onClose();
    projectToast('Проект создан', name.trim());
    await loadSidebar().catch(() => undefined);
  }
  return createPortal(
    <div className="scrim" role="presentation">
      <section className="modal project-editor" role="dialog" aria-modal="true" aria-busy={busy} aria-label="Новый проект" ref={ref}>
        <header className="modal-head">
          <h2>Новый проект</h2>
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
            <div className="field">
              <label htmlFor="new-project-name">Название</label>
              <input
                id="new-project-name"
                ref={nameRef}
                className="input"
                required
                maxLength={120}
                value={name}
                aria-invalid={!!error}
                aria-describedby={error ? 'new-project-error' : undefined}
                onChange={event => {
                  setName(event.target.value);
                  setError('');
                }}
              />
              {error && (
                <span id="new-project-error" role="alert" className="field-error">
                  {error}
                </span>
              )}
            </div>
            <fieldset>
              <legend>Цвет проекта</legend>
              <ProjectPalette
                value={color}
                onChange={value => {
                  picked.current = true;
                  setColor(value);
                }}
              />
            </fieldset>
            <label className="field">
              Описание
              <textarea className="input" maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} />
            </label>
          </div>
          <footer className="modal-foot">
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              Создать
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  );
}
