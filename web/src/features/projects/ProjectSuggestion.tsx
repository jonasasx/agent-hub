import { useState } from 'react';
import type { ProjectSuggestionAnswer } from '@agent-hub/shared';
import type { SessionView } from '../../api/types';
import { api, ApiError } from '../../api/client';
import { t, useT } from '../../i18n';
import { colorVar } from '../sessions/status';

/**
 * The card under the chat head when the classifier was not sure (spec `projects-catalog`): up to three projects of the
 * catalog, «Создать проект «имя»» with an editable name, and «Без проекта». Without options and a name the card still offers
 * «Новый проект…»: a session with no fitting project always gets the offer to create one. Nothing is assigned until a click.
 */
export function ProjectSuggestion({ s }: { s: SessionView }) {
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
    <div className="banner project-suggestion" role="status">
      <div className="b-text">
        {options.length ? tr('projects.suggest.unsure') : tr('projects.suggest.none')}
        {error && <span role="alert"> {error}</span>}
      </div>
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
            <button type="button" className="btn primary" disabled={busy} onClick={create}>
              {tr('projects.suggest.createNamed', { name: proposed })}
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
      <button type="button" className="btn" disabled={busy} onClick={() => void answer({ action: 'dismiss', inputHash: suggestion.inputHash })}>
        {tr('projects.none')}
      </button>
    </div>
  );
}
