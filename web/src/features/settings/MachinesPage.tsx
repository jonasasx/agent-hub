/**
 * «Настройки → Машины» (change `multi-user`).
 * Requirement (runner-enrollment): Экран «Машины» — name, OS, status («в сети» / «не в сети с …»), agent version with
 * «устарела», Claude login («есть» / «нет входа»), last activity; «Переименовать», «Добавить машину», «Переподключить»,
 * «Отключить» with the uninstall command. Scenarios «Отключение машины», «Нет входа в Claude».
 * Requirement: macOS — the warning about the full disk access. Requirement: Самообновление агента — «обновление не удалось».
 * API: GET /api/runners, PATCH /api/runners/:id, POST /api/runners/:id/disable (D10).
 * Requirement (machine-mcp-onboarding): Повторный импорт со страницы машины — the MCP block: registry state, skipped
 * servers of the auto-import and «Импортировать MCP» (disabled for an agent without `mcp.import.v2`), change `mcp-hub-only`.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError, api } from '../../api/client';
import type { McpRegistryAgentStatus } from '../../api/mcpRegistryTypes';
import type { RunnerDetail, RunnerView } from '../../api/types';
import { t, useT } from '../../i18n';
import { useStore } from '../../store';
import { MCP_IMPORT_V2_CAPABILITY } from '@agent-hub/shared';
import { formatLastSeen } from '../machines/runnerInfo';
import { CommandBox, MacDiskWarning } from '../machines/EnrollModal';
import { claudeLoginCommand, needsClaudeLogin, osFamily } from '../machines/machines';
import { useUnsavedInput } from '../update/unsaved';
import { ProviderStatusRow } from '../machines/ProviderLogin';
import { McpImportDialog } from '../mcp/McpImportDialog';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; runners: RunnerView[]; agentVersion: string | null };

function statusLine(r: RunnerView): { text: string; cls: string } {
  if (r.state === 'disabled') return { text: t('settings.machines.statusDisabled'), cls: 'off' };
  if (r.state === 'pending') return { text: t('settings.machines.statusPending'), cls: 'warn' };
  if (r.online) return { text: t('machines.status.online'), cls: 'ok' };
  const seen = formatLastSeen(r.lastSeenAt);
  return { text: seen ? t('machines.tip.offlineSince', { since: seen }) : t('machines.status.offline'), cls: 'bad' };
}

function Rename({ r, onDone }: { r: RunnerView; onDone: (r: RunnerView | null) => void }) {
  const tr = useT();
  const id = useId();
  const [name, setName] = useState(r.name);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useUnsavedInput(name !== r.name);
  const save = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setErr(tr('settings.machines.nameRequired'));
    if (n === r.name) return onDone(null);
    setBusy(true);
    try {
      onDone(await api.renameRunner(r.id, n));
    } catch (e2) {
      setErr(e2 instanceof ApiError && e2.code === 'name_taken' ? tr('settings.machines.nameTaken') : tr('settings.machines.saveFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="rename" onSubmit={e => void save(e)}>
      <label className="sr-only" htmlFor={id}>
        {tr('settings.machines.renameLabel', { name: r.name })}
      </label>
      <input
        id={id}
        className="input"
        value={name}
        maxLength={64}
        autoFocus
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Escape' && (e.stopPropagation(), onDone(null))}
        aria-invalid={!!err}
        aria-describedby={err ? `${id}-err` : undefined}
      />
      <button type="submit" className="btn primary" disabled={busy}>
        {tr('settings.machines.save')}
      </button>
      <button type="button" className="btn ghost" onClick={() => onDone(null)}>
        {tr('settings.machines.cancel')}
      </button>
      {err && (
        <span className="field-error" id={`${id}-err`} role="alert">
          {err}
        </span>
      )}
    </form>
  );
}

function MachineCard({
  r,
  agentVersion,
  mcp,
  onChange,
  onMcpImported,
}: {
  r: RunnerView;
  agentVersion: string | null;
  mcp: McpRegistryAgentStatus | undefined;
  onChange: (r: RunnerView) => void;
  onMcpImported: () => void;
}) {
  const tr = useT();
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [disabled, setDisabled] = useState<RunnerDetail | null>(null);
  const st = statusLine(r);
  const isMac = osFamily(r.os) === 'macos';
  const off = r.state === 'disabled';
  const disable = async () => {
    setBusy(true);
    setErr(null);
    try {
      const d = await api.disableRunner(r.id);
      setDisabled(d);
      setConfirm(false);
      onChange(d);
    } catch {
      setErr(tr('settings.machines.disableFailed'));
    } finally {
      setBusy(false);
    }
  };
  const uninstall = disabled?.uninstallCommand;
  return (
    <li className={`mcard${off ? ' disabled' : ''}`} aria-label={r.name} data-runner={r.id} tabIndex={-1}>
      <div className="mc-head">
        <span className={`dot ${st.cls}`} aria-hidden="true" />
        {renaming ? (
          <Rename
            r={r}
            onDone={nr => {
              setRenaming(false);
              if (nr) onChange(nr);
            }}
          />
        ) : (
          <h3 className="mc-name">{r.name}</h3>
        )}
        <span className="mc-status">{st.text}</span>
      </div>
      <dl className="mc-facts">
        <div>
          <dt>{tr('settings.machines.factSystem')}</dt>
          <dd>{r.os ?? '—'}</dd>
        </div>
        <div>
          <dt>{tr('settings.machines.factAgent')}</dt>
          {/* UI review H2/M4: the version is its own flex item (the tags get a gap), numbers in the mono face of «.ver-line b» */}
          <dd className="ag">
            <span className="mc-ver">
              {r.agentVersion ? <span className="num">{r.agentVersion}</span> : '—'}
              {r.agentVersion && r.protocolVersion ? (
                <>
                  {` · ${tr('settings.machines.protocol')} `}
                  <span className="num">{r.protocolVersion}</span>
                </>
              ) : null}
            </span>
            {r.outdated && (
              <span className="tag warn" title={agentVersion ? tr('settings.machines.currentVersion', { version: agentVersion }) : undefined}>
                {tr('settings.machines.outdated')}
              </span>
            )}
            {r.update?.status === 'failed' && <span className="tag bad">{tr('settings.machines.updateFailed')}</span>}
            {r.update && r.update.status !== 'failed' && <span className="tag">{tr('settings.machines.updatingTo', { version: r.update.version })}</span>}
          </dd>
        </div>
        <div>
          <dt>Claude</dt>
          <dd>{r.claudeLogin === 'ok' ? tr('settings.machines.claudeOk') : needsClaudeLogin(r) ? <span className="tag bad">{tr('settings.machines.claudeNo')}</span> : '—'}</dd>
        </div>
        {!off && r.providers?.some(p => p.id === 'codex') && <ProviderStatusRow r={r} provider="codex" />}
        <div>
          <dt>{tr('settings.machines.factActivity')}</dt>
          <dd>{formatLastSeen(r.lastSeenAt) ?? tr('machines.tip.neverConnected')}</dd>
        </div>
      </dl>
      {!off && needsClaudeLogin(r) && (
        <div className="banner warn inline-warn" role="status">
          <div className="b-text">
            <b>{tr('machines.enroll.noLoginTitle')}</b> {tr('settings.machines.noLoginBody')}
            <CommandBox command={claudeLoginCommand(r.os)} label={tr('settings.machines.loginCmdLabel', { name: r.name })} />
          </div>
        </div>
      )}
      {!off && isMac && r.protectedDirsOk === false && <MacDiskWarning />}
      {!off && r.runsAsRoot === true && (
        <div className="banner warn inline-warn" role="status">
          <div className="b-text">
            <b>{tr('settings.machines.rootTitle')}</b> {tr('settings.machines.rootBody')}
          </div>
        </div>
      )}
      {off && !uninstall && <p className="hint">{tr('settings.machines.offNote')}</p>}
      {uninstall && (
        <div className="banner inline-warn" role="status">
          <div className="b-text">
            <b>{tr('settings.machines.uninstallTitle')}</b> {tr('settings.machines.uninstallBody')}
            <CommandBox command={osFamily(r.os) === 'windows' ? uninstall.windows : uninstall.unix} label={tr('settings.machines.uninstallLabel', { name: r.name })} />
            <span className="hint">{tr('settings.machines.uninstallNote')}</span>
          </div>
        </div>
      )}
      {confirm && (
        <div
          className="banner warn inline-warn"
          role="alertdialog"
          aria-label={tr('settings.machines.confirmLabel', { name: r.name })}
          onKeyDown={e => e.key === 'Escape' && (e.stopPropagation(), setConfirm(false))}
        >
          <div className="b-text">
            <b>{tr('settings.machines.confirmLabel', { name: r.name })}</b> {tr('settings.machines.confirmBody')}
          </div>
          <button type="button" className="btn ghost" autoFocus onClick={() => setConfirm(false)}>
            {tr('settings.machines.cancel')}
          </button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => void disable()}>
            {busy ? tr('settings.machines.disabling') : tr('settings.machines.disable')}
          </button>
        </div>
      )}
      {err && (
        <div className="err-box" role="alert">
          {err}
        </div>
      )}
      {!off && !renaming && !confirm && (
        <div className="mc-actions">
          {r.state === 'pending' ? (
            <button type="button" className="btn primary" onClick={() => useStore.setState({ modal: { type: 'enroll', runnerId: r.id } })}>
              {tr('settings.machines.showCommand')}
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => useStore.setState({ modal: { type: 'enroll', runnerId: r.id } })}>
              {tr('settings.machines.reconnect')}
            </button>
          )}
          <button type="button" className="btn" onClick={() => setRenaming(true)}>
            {tr('settings.machines.rename')}
          </button>
          <button type="button" className="btn ghost danger-text" onClick={() => setConfirm(true)}>
            {tr('settings.machines.disable')}
          </button>
        </div>
      )}
      {/* UI review M5: the MCP block after the machine's own buttons, in a box of its own */}
      {!off && r.state !== 'pending' && mcp && <MachineMcp r={r} mcp={mcp} onImported={onMcpImported} />}
    </li>
  );
}

function MachineMcp({ r, mcp, onImported }: { r: RunnerView; mcp: McpRegistryAgentStatus | undefined; onImported: () => void }) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const supported = !!mcp?.capabilities.includes(MCP_IMPORT_V2_CAPABILITY);
  const pending = mcp?.importState === 'auto-pending';
  const skipped = mcp?.importReport?.skipped ?? [];
  const reason = !supported ? tr('settings.machines.mcp.needsUpdate') : !r.online ? tr('settings.machines.mcp.offline') : null;
  return (
    <div className="mc-mcp" data-testid="machine-mcp">
      <div className="mc-mcp-head">
        <b>{tr('settings.machines.mcp.title')}</b>
        <span className={`pill ${pending ? 'warn' : 'ok'}`}>{pending ? tr('settings.machines.mcp.pending') : tr('settings.machines.mcp.done')}</span>
        <button type="button" className="btn" disabled={!!reason} title={reason ?? undefined} onClick={() => setOpen(true)}>
          {tr('settings.machines.mcp.import')}
        </button>
      </div>
      {reason && <span className="hint">{reason}</span>}
      {skipped.length > 0 && <span className="hint">{tr('settings.machines.mcp.skipped', { count: skipped.length, names: skipped.join(', ') })}</span>}
      {open && <McpImportDialog machineId={r.id} machineName={r.name} onClose={() => setOpen(false)} onImported={() => onImported()} />}
    </div>
  );
}

export function MachinesPage() {
  const tr = useT();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  // live statuses (runner.status / runner.enroll) of the panel's machines win over the loaded list
  const liveRunners = useStore(s => s.runners);
  const modalOpen = useStore(s => s.modal?.type === 'enroll');
  const [mcpAgents, setMcpAgents] = useState<McpRegistryAgentStatus[]>([]);
  const fetchList = useCallback(() => {
    api
      .runners()
      .then(r => setLoad({ kind: 'ok', runners: r.runners.filter(x => x.kind === 'machine'), agentVersion: r.agentVersion }))
      .catch(() => setLoad({ kind: 'error' }));
    // the MCP block is secondary: a failed registry status leaves the cards without it, not the page in error
    api
      .mcpRegistryStatus()
      .then(status => setMcpAgents(status.agents ?? []))
      .catch(() => setMcpAgents([]));
  }, []);
  // on open, and when the enrollment window closes: a machine added or reconnected there shows up
  useEffect(() => {
    if (!modalOpen) fetchList();
  }, [modalOpen, fetchList]);

  const update = (r: RunnerView) => {
    if (load.kind !== 'ok') return;
    setLoad({ ...load, runners: load.runners.map(x => (x.id === r.id ? { ...x, ...r } : x)) });
    if (r.state !== 'pending') useStore.getState().upsertRunner(r);
  };

  const list =
    load.kind === 'ok'
      ? load.runners.map(r => {
          const l = liveRunners.find(x => x.id === r.id);
          return l && r.state !== 'disabled' ? { ...r, ...l } : r;
        })
      : [];
  const active = list.filter(r => r.state !== 'disabled');
  const off = list.filter(r => r.state === 'disabled');

  return (
    <section aria-labelledby="set-machines">
      <div className="set-head">
        <h2 id="set-machines">{tr('settings.machines.title')}</h2>
        <button type="button" className="btn primary" onClick={() => useStore.setState({ modal: { type: 'enroll' } })}>
          {tr('settings.machines.add')}
        </button>
      </div>
      <p className="hint">{tr('settings.machines.hint')}</p>
      {/* change client-versions D8: the agent build the hub hands out; none — no line */}
      {load.kind === 'ok' && load.agentVersion && (
        <p className="ver-line">
          {tr('settings.machines.latestAgent')} <b>{load.agentVersion}</b>
        </p>
      )}
      {load.kind === 'loading' && (
        <p className="hint" role="status">
          <span className="spinner" aria-hidden="true" /> {tr('settings.common.loading')}
        </p>
      )}
      {load.kind === 'error' && (
        <div className="err-box" role="alert">
          {tr('settings.machines.listError')}{' '}
          <button type="button" className="btn" onClick={fetchList}>
            {tr('settings.common.retry')}
          </button>
        </div>
      )}
      {load.kind === 'ok' && !list.length && <p className="empty-note">{tr('settings.machines.empty')}</p>}
      {/* one list: a machine disabled here keeps its card (and the uninstall command) while it moves down */}
      {!!list.length && (
        <ul className="mcards">
          {[...active, ...off].flatMap((r, i) => [
            ...(i === active.length && off.length
              ? [
                  <li key="off-h" className="set-sub" role="presentation">
                    {tr('settings.machines.disabledHead')}
                  </li>,
                ]
              : []),
            <MachineCard
              key={r.id}
              r={r}
              agentVersion={load.kind === 'ok' ? load.agentVersion : null}
              mcp={mcpAgents.find(agent => agent.machineId === r.id)}
              onChange={update}
              onMcpImported={fetchList}
            />,
          ])}
        </ul>
      )}
    </section>
  );
}
