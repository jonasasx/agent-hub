/**
 * «Настройки → Машины» (change `multi-user`).
 * Requirement (runner-enrollment): Экран «Машины» — name, OS, status («в сети» / «не в сети с …»), agent version with
 * «устарела», Claude login («есть» / «нет входа»), last activity; «Переименовать», «Добавить машину», «Переподключить»,
 * «Отключить» with the uninstall command. Scenarios «Отключение машины», «Нет входа в Claude».
 * Requirement: macOS — the warning about the full disk access. Requirement: Самообновление агента — «обновление не удалось».
 * API: GET /api/runners, PATCH /api/runners/:id, POST /api/runners/:id/disable (D10).
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError, api } from '../../api/client';
import type { RunnerDetail, RunnerView } from '../../api/types';
import { useStore } from '../../store';
import { formatLastSeen } from '../machines/RunnerFooter';
import { CommandBox, MacDiskWarning } from '../machines/EnrollModal';
import { claudeLoginCommand, needsClaudeLogin, osFamily } from '../machines/machines';
import { useUnsavedInput } from '../update/unsaved';
import { ProviderStatusRow } from '../machines/ProviderLogin';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; runners: RunnerView[]; agentVersion: string | null };

function statusLine(r: RunnerView): { text: string; cls: string } {
  if (r.state === 'disabled') return { text: 'отключена', cls: 'off' };
  if (r.state === 'pending') return { text: 'ожидает подключения', cls: 'warn' };
  if (r.online) return { text: 'в сети', cls: 'ok' };
  const seen = formatLastSeen(r.lastSeenAt);
  return { text: seen ? `не в сети с ${seen}` : 'не в сети', cls: 'bad' };
}

function Rename({ r, onDone }: { r: RunnerView; onDone: (r: RunnerView | null) => void }) {
  const id = useId();
  const [name, setName] = useState(r.name);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useUnsavedInput(name !== r.name);
  const save = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setErr('Укажите имя');
    if (n === r.name) return onDone(null);
    setBusy(true);
    try {
      onDone(await api.renameRunner(r.id, n));
    } catch (e2) {
      setErr(e2 instanceof ApiError && e2.code === 'name_taken' ? 'Машина с таким именем уже есть' : 'Не сохранено. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="rename" onSubmit={e => void save(e)}>
      <label className="sr-only" htmlFor={id}>
        Новое имя для {r.name}
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
        Сохранить
      </button>
      <button type="button" className="btn ghost" onClick={() => onDone(null)}>
        Отмена
      </button>
      {err && (
        <span className="field-error" id={`${id}-err`} role="alert">
          {err}
        </span>
      )}
    </form>
  );
}

function MachineCard({ r, agentVersion, onChange }: { r: RunnerView; agentVersion: string | null; onChange: (r: RunnerView) => void }) {
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
      setErr('Машина не отключена. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };
  const uninstall = disabled?.uninstallCommand;
  return (
    <li className={`mcard${off ? ' disabled' : ''}`} aria-label={r.name}>
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
          <dt>Система</dt>
          <dd>{r.os ?? '—'}</dd>
        </div>
        <div>
          <dt>Агент</dt>
          {/* UI review H2/M4: the version is its own flex item (the tags get a gap), numbers in the mono face of «.ver-line b» */}
          <dd className="ag">
            <span className="mc-ver">
              {r.agentVersion ? <span className="num">{r.agentVersion}</span> : '—'}
              {r.agentVersion && r.protocolVersion ? (
                <>
                  {' · протокол '}
                  <span className="num">{r.protocolVersion}</span>
                </>
              ) : null}
            </span>
            {r.outdated && (
              <span className="tag warn" title={agentVersion ? `Текущая версия ${agentVersion}; обновится сама` : undefined}>
                устарела
              </span>
            )}
            {r.update?.status === 'failed' && <span className="tag bad">обновление не удалось</span>}
            {r.update && r.update.status !== 'failed' && <span className="tag">обновляется до {r.update.version}</span>}
          </dd>
        </div>
        <div>
          <dt>Claude</dt>
          <dd>{r.claudeLogin === 'ok' ? 'вход есть' : needsClaudeLogin(r) ? <span className="tag bad">нет входа</span> : '—'}</dd>
        </div>
        {!off && r.providers?.some(p => p.id === 'codex') && <ProviderStatusRow r={r} provider="codex" />}
        <div>
          <dt>Активность</dt>
          <dd>{formatLastSeen(r.lastSeenAt) ?? 'ещё не подключалась'}</dd>
        </div>
      </dl>
      {!off && needsClaudeLogin(r) && (
        <div className="banner warn inline-warn" role="status">
          <div className="b-text">
            <b>Нет входа в Claude.</b> Сессии на этой машине не запустятся. Выполните на машине:
            <CommandBox command={claudeLoginCommand(r.os)} label={`Команда входа в Claude на ${r.name}`} />
          </div>
        </div>
      )}
      {!off && isMac && r.protectedDirsOk === false && <MacDiskWarning />}
      {!off && r.runsAsRoot === true && (
        <div className="banner warn inline-warn" role="status">
          <div className="b-text">
            <b>Работает под root — режим bypassPermissions недоступен.</b> Claude Code не запускает его под root: сессии на этой машине — только в режимах с запросом разрешений. Чтобы вернуть режим,
            переустановите агента под обычным пользователем.
          </div>
        </div>
      )}
      {off && !uninstall && <p className="hint">Отключена. Сессии этой машины открываются только для чтения.</p>}
      {uninstall && (
        <div className="banner inline-warn" role="status">
          <div className="b-text">
            <b>Машина отключена.</b> Сессии остаются только для чтения. Чтобы удалить агента, выполните на машине:
            <CommandBox command={osFamily(r.os) === 'windows' ? uninstall.windows : uninstall.unix} label={`Команда удаления агента с ${r.name}`} />
            <span className="hint">~/.claude и история сессий не удаляются.</span>
          </div>
        </div>
      )}
      {confirm && (
        <div className="banner warn inline-warn" role="alertdialog" aria-label={`Отключить ${r.name}?`}>
          <div className="b-text">
            <b>Отключить {r.name}?</b> Агент отключится сразу, запускать сессии на машине будет нельзя. Подключить её снова — через «Добавить машину».
          </div>
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>
            Отмена
          </button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => void disable()}>
            {busy ? 'Отключаем…' : 'Отключить'}
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
              Показать команду
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => useStore.setState({ modal: { type: 'enroll', runnerId: r.id } })}>
              Переподключить
            </button>
          )}
          <button type="button" className="btn" onClick={() => setRenaming(true)}>
            Переименовать
          </button>
          <button type="button" className="btn ghost danger-text" onClick={() => setConfirm(true)}>
            Отключить
          </button>
        </div>
      )}
      {/* UI review M5: the MCP block after the machine's own buttons, in a box of its own */}
    </li>
  );
}

export function MachinesPage() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  // live statuses (runner.status / runner.enroll) of the panel's machines win over the loaded list
  const liveRunners = useStore(s => s.runners);
  const modalOpen = useStore(s => s.modal?.type === 'enroll');
  const fetchList = useCallback(() => {
    api
      .runners()
      .then(r => setLoad({ kind: 'ok', runners: r.runners.filter(x => x.kind === 'machine'), agentVersion: r.agentVersion }))
      .catch(() => setLoad({ kind: 'error' }));
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
        <h2 id="set-machines">Машины</h2>
        <button type="button" className="btn primary" onClick={() => useStore.setState({ modal: { type: 'enroll' } })}>
          Добавить машину
        </button>
      </div>
      <p className="hint">Машины, на которых работают ваши агенты. Агент обновляется сам между ходами.</p>
      {/* change client-versions D8: the agent build the hub hands out; none — no line */}
      {load.kind === 'ok' && load.agentVersion && (
        <p className="ver-line">
          Актуальная версия агента <b>{load.agentVersion}</b>
        </p>
      )}
      {load.kind === 'loading' && (
        <p className="hint" role="status">
          <span className="spinner" aria-hidden="true" /> Загрузка…
        </p>
      )}
      {load.kind === 'error' && (
        <div className="err-box" role="alert">
          Список машин не загружен.{' '}
          <button type="button" className="btn" onClick={fetchList}>
            Повторить
          </button>
        </div>
      )}
      {load.kind === 'ok' && !list.length && <p className="empty-note">Машин пока нет. Нажмите «Добавить машину».</p>}
      {/* one list: a machine disabled here keeps its card (and the uninstall command) while it moves down */}
      {!!list.length && (
        <ul className="mcards">
          {[...active, ...off].flatMap((r, i) => [
            ...(i === active.length && off.length
              ? [
                  <li key="off-h" className="set-sub" role="presentation">
                    Отключённые
                  </li>,
                ]
              : []),
            <MachineCard key={r.id} r={r} agentVersion={load.kind === 'ok' ? load.agentVersion : null} onChange={update} />,
          ])}
        </ul>
      )}
    </section>
  );
}
