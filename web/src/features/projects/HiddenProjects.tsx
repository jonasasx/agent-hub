import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectRef } from '../../api/types';
import { api } from '../../api/client';
import { t, useT } from '../../i18n';
import { useDialog } from '../ui/a11y';
import { loadSidebar } from '../workspace/actions';
import { projectError } from './ProjectActions';
export function HiddenProjects({ onClose }: { onClose: () => void }) {
  const tr = useT();
  const [groups, setGroups] = useState<ProjectRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const ref = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useDialog(ref, onClose, close);
  useEffect(() => {
    void api
      .hiddenProjectGroups()
      .then(setGroups)
      .catch(() => setError(t('projects.hidden.loadFailed')))
      .finally(() => setLoading(false));
  }, []);
  async function restore(id: string) {
    try {
      await api.hideProjectGroup(id, false);
      setGroups(current => current.filter(p => p.id !== id));
    } catch (failure) {
      setError(projectError(failure));
      return;
    }
    try {
      await loadSidebar();
    } catch (failure) {
      console.warn('Не удалось обновить сайдбар', failure);
    }
  }
  return createPortal(
    <div className="scrim">
      <section className="modal project-editor" role="dialog" aria-modal="true" aria-label={tr('projects.hidden.title')} ref={ref}>
        <header className="modal-head">
          <h2>{tr('projects.hidden.title')}</h2>
          <button type="button" ref={close} className="icon-btn" aria-label={tr('projects.hidden.close')} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body">
          {loading ? (
            <p role="status">{tr('projects.hidden.loading')}</p>
          ) : groups.length ? (
            groups.map(group => (
              <div className="hidden-project" key={group.id}>
                <span>{group.title}</span>
                <button type="button" className="btn" onClick={() => void restore(group.id!)} aria-label={tr('projects.hidden.restoreLabel', { title: group.title })}>
                  {tr('projects.hidden.restore')}
                </button>
              </div>
            ))
          ) : (
            <p>{tr('projects.hidden.empty')}</p>
          )}
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
