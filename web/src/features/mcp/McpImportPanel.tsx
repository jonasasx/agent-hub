/**
 * Import preview of a machine's MCP configuration (change `mcp-hub-only`, D9).
 * Requirement (machine-mcp-onboarding): Шаг MCP в мастере подключения машины; Повторный импорт со страницы машины.
 * The panel scans the machine on mount (`POST /api/mcp/registry/import/preview`), shows the found servers with checkboxes
 * (preselected by the hub), the decision and the warnings, and commits the selected ones (`POST .../import/commit`).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, api } from '../../api/client';
import type { McpImportCommitResponse, McpImportEntry, McpImportPreviewResponse } from '../../api/mcpRegistryTypes';
import { t, useT } from '../../i18n';

type PanelState =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'preview'; preview: McpImportPreviewResponse }
  | { kind: 'committing'; preview: McpImportPreviewResponse }
  | { kind: 'done'; result: McpImportCommitResponse };

export interface McpImportPanelProps {
  machineId: string;
  /** «Пропустить» before the import, «Закрыть» after it or when nothing was found. */
  onClose: () => void;
  onImported?: (result: McpImportCommitResponse) => void;
  /** Label of the button that leaves without importing; «Пропустить» by default. */
  skipLabel?: string;
  /** Extra buttons next to «Закрыть» once the import is done or nothing was found (the wizard puts «Начать первую сессию» there). */
  doneActions?: ReactNode;
}

export function McpImportPanel({ machineId, onClose, onImported, skipLabel, doneActions }: McpImportPanelProps) {
  const t = useT();
  const [state, setState] = useState<PanelState>({ kind: 'loading' });
  const [selected, setSelected] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    api
      .mcpRegistryImportPreview({ machineId })
      .then(preview => {
        if (cancelled) return;
        setSelected(preview.servers.filter(entry => entry.selectable && entry.selected).map(entry => entry.id));
        setState({ kind: 'preview', preview });
      })
      .catch(cause => {
        if (!cancelled) setState({ kind: 'error', text: importErrorText(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [machineId, attempt]);

  const commit = async (preview: McpImportPreviewResponse) => {
    setState({ kind: 'committing', preview });
    try {
      const result = await api.mcpRegistryImportCommit({ importId: preview.importId, revision: preview.revision, serverIds: selected, userConfirmed: true });
      setState({ kind: 'done', result });
      onImported?.(result);
    } catch (cause) {
      setState({ kind: 'error', text: importErrorText(cause) });
    }
  };

  const toggle = (entryId: string, checked: boolean) => {
    setSelected(current => (checked ? [...current, entryId] : current.filter(id => id !== entryId)));
  };

  if (state.kind === 'loading') {
    return (
      <div className="mcp-import-panel" data-testid="mcp-import-panel">
        <p className="hint" role="status">
          <span className="spinner" aria-hidden="true" /> {t('mcp.import.scanning')}
        </p>
        <div className="mcp-import-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            {skipLabel ?? t('mcp.import.skip')}
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="mcp-import-panel" data-testid="mcp-import-panel">
        <div className="err-box" role="alert">
          {state.text}
        </div>
        <div className="mcp-import-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('mcp.import.close')}
          </button>
          <button type="button" className="btn primary" onClick={() => setAttempt(value => value + 1)}>
            {t('mcp.import.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === 'done') {
    return (
      <div className="mcp-import-panel" data-testid="mcp-import-panel">
        <p className="mcp-note ok" role="status">
          {t('mcp.import.imported', { count: state.result.imported })}
        </p>
        <div className="mcp-import-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('mcp.import.close')}
          </button>
          {doneActions}
        </div>
      </div>
    );
  }

  const { preview } = state;
  const busy = state.kind === 'committing';
  return (
    <div className="mcp-import-panel" data-testid="mcp-import-panel">
      {preview.servers.length === 0 ? (
        <p className="hint">{t('mcp.import.empty')}</p>
      ) : (
        <>
          <p className="hint">{t('mcp.import.lead', { count: preview.servers.length, secrets: preview.secretsCaptured })}</p>
          <table className="mcp-import-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">{t('mcp.import.colSelect')}</span>
                </th>
                <th scope="col">{t('mcp.import.colName')}</th>
                <th scope="col">{t('mcp.import.colSource')}</th>
                <th scope="col">{t('mcp.import.colDecision')}</th>
              </tr>
            </thead>
            <tbody>
              {preview.servers.map(entry => (
                <ImportRow key={entry.id} entry={entry} checked={selected.includes(entry.id)} disabled={busy || !entry.selectable} onToggle={toggle} />
              ))}
            </tbody>
          </table>
          <p className="hint">{t('mcp.import.secretsNote')}</p>
        </>
      )}
      {preview.warnings.map(warning => (
        <p key={warning} className="mcp-note warn">
          {warning}
        </p>
      ))}
      {preview.notices.includes('claude-ai-connectors') && <p className="mcp-note info">{t('mcp.import.claudeAiNotice')}</p>}
      <div className="mcp-import-foot">
        <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
          {preview.servers.length === 0 ? t('mcp.import.close') : (skipLabel ?? t('mcp.import.skip'))}
        </button>
        {preview.servers.length === 0 && doneActions}
        {preview.servers.length > 0 && (
          <button type="button" className="btn primary" disabled={busy || selected.length === 0} onClick={() => void commit(preview)}>
            {busy ? t('mcp.import.importing') : t('mcp.import.submit', { count: selected.length })}
          </button>
        )}
      </div>
    </div>
  );
}

function ImportRow({ entry, checked, disabled, onToggle }: { entry: McpImportEntry; checked: boolean; disabled: boolean; onToggle: (entryId: string, checked: boolean) => void }) {
  const t = useT();
  const target = entry.url ?? entry.command;
  const checkboxId = `mcp-import-${entry.id}`;
  return (
    <tr className={entry.selectable ? undefined : 'muted'}>
      <td>
        <input id={checkboxId} className="mcp-checkbox" type="checkbox" checked={checked} disabled={disabled} onChange={event => onToggle(entry.id, event.target.checked)} />
      </td>
      <td>
        <label htmlFor={checkboxId}>
          <strong>{entry.name}</strong>
        </label>
        {target && <code className="mcp-target">{target}</code>}
        {entry.secrets.length > 0 && <small>{t('mcp.import.secrets', { names: entry.secrets.map(secret => secret.name).join(', ') })}</small>}
        {/* the plugin id sits under the target: the narrow source column broke it mid-word */}
        {entry.origin && <small className="mono">{entry.origin}</small>}
      </td>
      <td>
        <span>{importSourceLabel(entry.source)}</span>
      </td>
      <td>
        <span className={`pill ${entry.decision === 'conflict' ? 'warn' : ''}`}>{importDecisionLabel(entry.decision)}</span>
        {entry.warnings.map(warning => (
          <small key={warning} className="mcp-import-warning">
            {importWarningLabel(warning)}
          </small>
        ))}
      </td>
    </tr>
  );
}

export function importSourceLabel(source: McpImportEntry['source']): string {
  if (source === 'user') return t('mcp.import.source.user');
  if (source === 'local') return t('mcp.import.source.local');
  if (source === 'project') return t('mcp.import.source.project');
  if (source === 'codex') return t('mcp.import.source.codex');
  return t('mcp.import.source.plugin');
}

export function importDecisionLabel(decision: McpImportEntry['decision']): string {
  if (decision === 'new') return t('mcp.import.decision.new');
  if (decision === 'add-machine') return t('mcp.import.decision.addMachine');
  if (decision === 'machine-config') return t('mcp.import.decision.machineConfig');
  if (decision === 'unchanged') return t('mcp.import.decision.unchanged');
  return t('mcp.import.decision.conflict');
}

function importWarningLabel(warning: McpImportEntry['warnings'][number]): string {
  if (warning === 'unbound-path') return t('mcp.import.warning.unboundPath');
  if (warning === 'duplicate-skipped') return t('mcp.import.warning.duplicate');
  if (warning === 'disabled-in-source') return t('mcp.import.warning.disabled');
  return t('mcp.import.warning.projectConflict');
}

function importErrorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.code === 'agent_outdated') return t('mcp.import.error.outdated');
    if (cause.code === 'runner_offline') return t('mcp.import.error.offline');
    if (cause.code === 'timeout') return t('mcp.import.error.timeout');
    if (cause.code === 'import_busy') return t('mcp.import.error.busy');
    if (cause.code === 'revision_conflict' || cause.code === 'import_not_found' || cause.code === 'import_already_committed') return t('mcp.import.error.stale');
    if (cause.serverMessage) return cause.serverMessage;
  }
  return t('mcp.import.error.generic');
}
