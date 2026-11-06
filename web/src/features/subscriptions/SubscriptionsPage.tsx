/**
 * «Настройки → Подписки» and «Настройки → Расход» (design P9, P10, P12): the registry and the usage as two sections of
 * the settings screen of `multi-user`, in its `.set-body` (no window, no tabs of their own).
 * Requirements: Подписки и расход в настройках; Реестр подписок (add, rename, order by drag and ↑/↓, auto-switch,
 * replace the token, retire, bring back); Хранение токена подписки (the token only in a password input without
 * autocomplete, read once at submit and cleared — never in React state or the store; the mask `…abcd`; the banner
 * without SUBSCRIPTION_TOKEN_KEY); Исчерпан лимит подписки («лимит до HH:MM»); Токен отклонён (the mark); Учёт ходов
 * и расход по подпискам.
 * API: GET/POST /api/subscriptions, PATCH /api/subscriptions/:id, PUT …/:id/token, PUT …/order, GET …/usage.
 * UI review 6.6: `settingsTokenFor` (from the `auth` note) opens the token form of one subscription (H2); the name is
 * checked before the token is touched, the token is cleared only when the request leaves (H1); roving focus on the
 * periods (M7); the usage keeps the last table on a bad period, a total row, the period it shows (M8, M9).
 */
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { PROVIDER_LABELS, subscriptionTokenSchema, type Provider, type SubscriptionUsageResponse, type SubscriptionView } from '../../api/types';
import { CodexLoginFlow } from '../machines/ProviderLogin';
import { useStore } from '../../store';
import { currentLocale, fmt, t as tNow, useT } from '../../i18n';
import { useMenu, useMenuPlacement } from '../ui/a11y';
import { addSubscription, loadSubscriptions, loadUsage, patchSubscription, reorder, replaceToken } from './actions';
import { REGISTRY_PROVIDERS, activeSubs, fmtInt, fullOrder, limitUntil, localDate, moved, movedBefore, retiredSubs, tokenMask, usagePeriods, usageRange, type UsagePeriod } from './model';
import { useUnsavedInput } from '../update/unsaved';

const tokenFormat = (): string => tNow('subscriptions.error.badToken');
export const disabledText = (): string => tNow('subscriptions.error.disabled');

/** The token as typed in an uncontrolled input; the value never goes to React state or the store. */
function peekToken(ref: RefObject<HTMLInputElement | null>): string {
  return (ref.current?.value ?? '').trim();
}

/** Clears the token input once the request leaves: the value is in the DOM only while typed. */
function clearToken(ref: RefObject<HTMLInputElement | null>): void {
  if (ref.current) ref.current.value = '';
}

function TokenInput({ id, inputRef, invalid, describedBy, label }: { id: string; inputRef: RefObject<HTMLInputElement | null>; invalid: boolean; describedBy?: string; label?: string }) {
  return (
    <input
      id={id}
      ref={inputRef}
      className="input mono"
      type="password"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      placeholder="sk-ant-oat01-…"
      aria-label={label}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      data-1p-ignore
      data-lpignore="true"
    />
  );
}

/**
 * Roving focus of a radiogroup (UI review M7): ←/→ (and ↑/↓) move to the neighbour and choose it, Home/End —
 * the first and the last; only the chosen item is in the Tab order.
 */
function rovingKey<T>(e: KeyboardEvent<HTMLElement>, values: readonly T[], current: T, choose: (v: T) => void): void {
  const i = values.indexOf(current);
  const k = e.key;
  const next =
    k === 'ArrowRight' || k === 'ArrowDown'
      ? (i + 1) % values.length
      : k === 'ArrowLeft' || k === 'ArrowUp'
        ? (i - 1 + values.length) % values.length
        : k === 'Home'
          ? 0
          : k === 'End'
            ? values.length - 1
            : -1;
  if (next < 0) return;
  e.preventDefault();
  choose(values[next]!);
  e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
}

/**
 * «Настройки → Подписки». The token form to open comes once from the store (`settingsTokenFor`, set by
 * `openSettings('subscriptions', { tokenFor })`): kept here for rows that mount after the list loads, cleared in the
 * store at once — the next visit opens no form.
 */
export function SubscriptionsPage() {
  const t = useT();
  const [tokenFor] = useState(() => useStore.getState().settingsTokenFor ?? undefined);
  useEffect(() => {
    useStore.setState({ settingsTokenFor: null });
    void loadSubscriptions();
  }, []);
  return (
    <section className="subs-page" aria-labelledby="set-subscriptions">
      <div className="set-head">
        <h2 id="set-subscriptions">{t('subscriptions.page.title')}</h2>
      </div>
      <p className="hint">{t('subscriptions.page.intro')}</p>
      <Registry tokenFor={tokenFor} />
    </section>
  );
}

/**
 * The list of subscriptions is not there: loading, or the hub did not answer (network, 5xx — advisory of the review of
 * 10.x: no endless spinner). null — loaded.
 */
function SubsPending() {
  const t = useT();
  const subs = useStore(s => s.subs);
  const failed = useStore(s => s.subsError);
  const [busy, setBusy] = useState(false);
  if (subs) return null;
  if (!failed)
    return (
      <p className="hint" role="status">
        <span className="spinner" aria-hidden="true" /> {t('subscriptions.page.loading')}
      </p>
    );
  return (
    <div className="err-box" role="alert">
      {t('subscriptions.page.loadFailed')}
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void loadSubscriptions().finally(() => setBusy(false));
        }}
      >
        {busy ? t('subscriptions.page.retrying') : t('subscriptions.page.retry')}
      </button>
    </div>
  );
}

/** «Настройки → Расход». */
export function UsagePage() {
  const t = useT();
  // the names and the «выведена» marks come from the list: ask again if the start of the app did not get it
  useEffect(() => {
    if (!useStore.getState().subs) void loadSubscriptions();
  }, []);
  return (
    <section className="subs-page" aria-labelledby="set-usage">
      <div className="set-head">
        <h2 id="set-usage">{t('subscriptions.page.usageTitle')}</h2>
      </div>
      <SubsPending />
      <Usage />
    </section>
  );
}

function Registry({ tokenFor }: { tokenFor?: string }) {
  const t = useT();
  const subs = useStore(s => s.subs);
  if (!subs) return <SubsPending />;
  return (
    <>
      {!subs.enabled && (
        <div className="banner warn subs-banner" role="alert">
          <span className="b-text">
            <b>{disabledText()}</b> {t('subscriptions.page.disabledRest')}
          </span>
        </div>
      )}
      {REGISTRY_PROVIDERS.map(p => (
        <ProviderRegistry key={p} provider={p} tokenFor={tokenFor} />
      ))}
    </>
  );
}

/** The registry of one provider (the positions are shared: the order of a block is put back into the full list). */
function ProviderRegistry({ provider, tokenFor }: { provider: Provider; tokenFor?: string }) {
  const t = useT();
  const subs = useStore(s => s.subs);
  const [err, setErr] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined);
  if (!subs) return null;
  const active = activeSubs(subs, provider);
  const retired = retiredSubs(subs, provider);
  const ids = active.map(s => s.id);
  const defaultId = subs.byProvider?.[provider]?.defaultId ?? (provider === 'claude' ? subs.defaultId : null);
  const order = async (next: string[] | null) => {
    if (!next) return;
    const r = await reorder(fullOrder(subs, provider, next));
    setErr(r.ok ? null : r.message);
  };
  const label = PROVIDER_LABELS[provider];
  return (
    <div className="subs-provider" role="group" aria-label={label}>
      <h3 className="subs-h subs-provider-h">{label}</h3>
      <section aria-labelledby={`subs-active-h-${provider}`} className="subs-sec">
        <h3 id={`subs-active-h-${provider}`} className="subs-h">
          {t('subscriptions.page.active')}
          {active.length > 0 && <span className="hint"> · {t('subscriptions.page.activeOrderHint')}</span>}
        </h3>
        {active.length === 0 ? (
          <p className="hint">{provider === 'claude' ? t('subscriptions.page.noneClaude') : t('subscriptions.page.noneOther', { provider: label })}</p>
        ) : (
          <>
            {/* M4: one column header instead of the label in every row (the phone keeps the label in the row) */}
            <div className="subs-cols" aria-hidden="true">
              <span className="subs-col-auto">{t('subscriptions.page.autoSwitch')}</span>
              <span className="subs-col-rest" />
            </div>
            <ol className="subs-list" onDragOver={e => dragId && e.preventDefault()}>
              {active.map((s, i) => (
                <li
                  key={s.id}
                  className={`subs-row${dragId === s.id ? ' dragging' : ''}${dragId && dropBefore === s.id ? ' drop-before' : ''}${dragId && dropBefore === null && i === active.length - 1 ? ' drop-after' : ''}`}
                  draggable
                  onDragStart={e => {
                    setDragId(s.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', s.id);
                  }}
                  onDragOver={e => {
                    if (!dragId) return;
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    setDropBefore(e.clientY < r.top + r.height / 2 ? s.id : (active[i + 1]?.id ?? null));
                  }}
                  onDrop={e => {
                    e.preventDefault();
                    const id = dragId;
                    setDragId(null);
                    setDropBefore(undefined);
                    if (id && dropBefore !== undefined) void order(movedBefore(ids, id, dropBefore));
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropBefore(undefined);
                  }}
                >
                  <ActiveRow
                    s={s}
                    first={i === 0}
                    last={i === active.length - 1}
                    enabled={subs.enabled}
                    isDefault={defaultId === s.id}
                    openToken={tokenFor === s.id}
                    onMove={d => void order(moved(ids, s.id, d))}
                    onError={setErr}
                  />
                </li>
              ))}
            </ol>
          </>
        )}
        {err && (
          <p className="field-error" role="alert">
            {err}
          </p>
        )}
      </section>
      {provider === 'claude' ? (
        <AddForm enabled={subs.enabled} names={active.map(s => s.name)} autoFocusName={active.length === 0 && !tokenFor} />
      ) : (
        <CodexAddForm enabled={subs.enabled} names={active.map(s => s.name)} />
      )}
      {retired.length > 0 && (
        <section aria-labelledby={`subs-retired-h-${provider}`} className="subs-sec">
          <h3 id={`subs-retired-h-${provider}`} className="subs-h">
            {t('subscriptions.page.retired')} <span className="hint">· {t('subscriptions.page.retiredHint')}</span>
          </h3>
          <ul className="subs-list">
            {retired.map(s => (
              <li key={s.id} className="subs-row retired">
                <div className="subs-main">
                  <span className="subs-name" title={s.name}>
                    {s.name}
                  </span>
                  <span className="subs-meta mono">{tokenMask(s.tokenHint)}</span>
                </div>
                <div className="subs-ctl">
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void patchSubscription(s.id, { retired: false }).then(r => {
                        setErr(r.ok ? null : r.message);
                      })
                    }
                  >
                    {t('subscriptions.page.restore')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ActiveRow({
  s,
  first,
  last,
  enabled,
  isDefault,
  openToken,
  onMove,
  onError,
}: {
  s: SubscriptionView;
  first: boolean;
  last: boolean;
  enabled: boolean;
  isDefault: boolean;
  openToken: boolean;
  onMove: (delta: number) => void;
  onError: (m: string | null) => void;
}) {
  const [edit, setEdit] = useState<null | 'rename' | 'token'>(openToken && enabled ? 'token' : null);
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useMenu(menu, box, () => setMenu(false));
  const place = useMenuPlacement(menu, moreBtn, menuRef);
  const id = useId();
  const t = useT();
  const limit = limitUntil(s);
  const codex = s.provider === 'codex';
  return (
    <>
      <div className="subs-main">
        {/* the grip and the name never wrap apart (6.6 re-review, phone) */}
        <span className="subs-id">
          <span className="subs-grip" aria-hidden="true" title={t('subscriptions.row.dragTitle')}>
            ⋮⋮
          </span>
          <span className="subs-name" title={s.name}>
            {s.name}
          </span>
        </span>
        <span className="subs-meta mono" title={`${codex ? t('subscriptions.row.loginDone') : t('subscriptions.row.tokenReplaced')} ${fmt.dateTime(new Date(s.tokenUpdatedAt))}`}>
          {tokenMask(s.tokenHint)}
        </span>
        {isDefault && <span className="pill subs-tag">{t('subscriptions.row.default')}</span>}
        {limit && <span className="pill subs-tag warn">{limit}</span>}
        {s.tokenRejected && <span className="pill subs-tag bad">{codex ? t('subscriptions.row.loginRejected') : t('subscriptions.tokenRejected')}</span>}
        {/* H2: a rejected token is fixed from the row itself, not only from «⋯» */}
        {s.tokenRejected && enabled && edit !== 'token' && (
          <button type="button" className="btn subs-fix" onClick={() => setEdit('token')}>
            {codex ? t('subscriptions.row.relogin') : t('subscriptions.row.replaceToken')}
          </button>
        )}
      </div>
      <div className="subs-ctl">
        <label className="check subs-auto">
          <input
            type="checkbox"
            aria-label={t('subscriptions.row.autoAria', { name: s.name })}
            checked={s.autoSwitch}
            onChange={e =>
              void patchSubscription(s.id, { autoSwitch: e.target.checked }).then(r => {
                onError(r.ok ? null : r.message);
              })
            }
          />
          <span className="subs-auto-txt">{t('subscriptions.page.autoSwitch')}</span>
        </label>
        <button type="button" className="icon-btn" aria-label={t('subscriptions.row.upAria', { name: s.name })} title={t('subscriptions.row.up')} disabled={first} onClick={() => onMove(-1)}>
          ↑
        </button>
        <button type="button" className="icon-btn" aria-label={t('subscriptions.row.downAria', { name: s.name })} title={t('subscriptions.row.down')} disabled={last} onClick={() => onMove(1)}>
          ↓
        </button>
        <div className="subs-more" ref={box}>
          <button
            type="button"
            ref={moreBtn}
            className="icon-btn"
            aria-haspopup="menu"
            aria-expanded={menu}
            aria-label={t('subscriptions.row.actionsAria', { name: s.name })}
            title={t('subscriptions.row.actions')}
            onClick={() => setMenu(!menu)}
          >
            ⋯
          </button>
          {menu && (
            <div ref={menuRef} className={`menu${place === 'up' ? ' up' : ''}`} role="menu" aria-label={t('subscriptions.row.actionsMenu', { name: s.name })}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setEdit('rename');
                }}
              >
                {t('subscriptions.row.rename')}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!enabled}
                title={enabled ? undefined : disabledText()}
                onClick={() => {
                  setMenu(false);
                  setEdit('token');
                }}
              >
                {codex ? t('subscriptions.row.relogin') : t('subscriptions.row.replaceToken')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  setMenu(false);
                  void patchSubscription(s.id, { retired: true }).then(r => onError(r.ok ? null : r.message));
                }}
              >
                {t('subscriptions.row.retire')}
              </button>
            </div>
          )}
        </div>
      </div>
      {edit === 'rename' && <RenameForm id={id} s={s} onDone={() => setEdit(null)} />}
      {edit === 'token' && (codex ? <CodexReloginForm s={s} onDone={() => setEdit(null)} /> : <TokenForm id={id} s={s} onDone={() => setEdit(null)} />)}
    </>
  );
}

function RenameForm({ id, s, onDone }: { id: string; s: SubscriptionView; onDone: () => void }) {
  const t = useT();
  const [name, setName] = useState(s.name);
  useUnsavedInput(name !== s.name);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const n = name.trim();
    if (!n || n.length > 60) return setErr(t('subscriptions.row.nameRange'));
    if (n === s.name) return onDone();
    setBusy(true);
    const r = await patchSubscription(s.id, { name: n });
    setBusy(false);
    if (r.ok) onDone();
    else setErr(r.message);
  };
  return (
    <form className="subs-edit" onSubmit={e => void submit(e)}>
      <label htmlFor={`${id}-rn`}>{t('subscriptions.rename.newName')}</label>
      <div className="subs-edit-row">
        <input
          id={`${id}-rn`}
          className="input"
          value={name}
          maxLength={60}
          autoFocus
          onChange={e => setName(e.target.value)}
          aria-invalid={!!err}
          aria-describedby={err ? `${id}-rn-err` : undefined}
        />
        <button type="submit" className="btn primary" disabled={busy}>
          {t('subscriptions.page.save')}
        </button>
        <button type="button" className="btn ghost" onClick={onDone}>
          {t('subscriptions.page.cancel')}
        </button>
      </div>
      {err && (
        <span className="field-error" id={`${id}-rn-err`} role="alert">
          {err}
        </span>
      )}
    </form>
  );
}

function TokenForm({ id, s, onDone }: { id: string; s: SubscriptionView; onDone: () => void }) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  // client-versions D4: an open token form (the token is an uncontrolled input) blocks a silent reload
  useUnsavedInput(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const token = peekToken(ref);
    // H1: a bad token stays in the field to be fixed; it is cleared only when the request leaves
    if (!subscriptionTokenSchema.safeParse(token).success) return setErr(tokenFormat());
    clearToken(ref);
    setBusy(true);
    const r = await replaceToken(s.id, token);
    setBusy(false);
    if (r.ok) onDone();
    else setErr(r.message);
  };
  return (
    <form className="subs-edit" onSubmit={e => void submit(e)} autoComplete="off">
      <label htmlFor={`${id}-tk`}>{t('subscriptions.token.new', { name: s.name })}</label>
      <div className="subs-edit-row">
        <TokenInput id={`${id}-tk`} inputRef={ref} invalid={!!err} describedBy={err ? `${id}-tk-err` : undefined} />
        <button type="submit" className="btn primary" disabled={busy}>
          {t('subscriptions.token.replace')}
        </button>
        <button type="button" className="btn ghost" onClick={onDone}>
          {t('subscriptions.page.cancel')}
        </button>
      </div>
      {err && (
        <span className="field-error" id={`${id}-tk-err`} role="alert">
          {err}
        </span>
      )}
    </form>
  );
}

/** «Войти заново»: a new ChatGPT sign-in replaces the credential of the subscription. */
function CodexReloginForm({ s, onDone }: { s: SubscriptionView; onDone: () => void }) {
  const t = useT();
  useUnsavedInput(true);
  return (
    <div className="subs-edit">
      <span>{t('subscriptions.codex.relogin', { name: s.name })}</span>
      <CodexLoginFlow subscriptionId={s.id} label={t('subscriptions.row.relogin')} onEnd={ok => ok && onDone()} />
      <div className="subs-edit-row">
        <button type="button" className="btn ghost" onClick={onDone}>
          {t('subscriptions.page.close')}
        </button>
      </div>
    </div>
  );
}

/** A new Codex subscription: the name, then the ChatGPT sign-in on a machine; the hub adds it when the sign-in ends. */
function CodexAddForm({ enabled, names }: { enabled: boolean; names: string[] }) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState('');
  useUnsavedInput(name.trim() !== '');
  const [err, setErr] = useState<string | undefined>();
  const [done, setDone] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  return (
    <section className="subs-add" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="subs-h">
        {t('subscriptions.codex.addTitle')}
      </h3>
      <div className="field">
        <label htmlFor={`${id}-n`}>{t('subscriptions.codex.name')}</label>
        <input
          id={`${id}-n`}
          ref={nameRef}
          className="input"
          value={name}
          maxLength={60}
          disabled={!enabled}
          placeholder={t('subscriptions.codex.namePlaceholder')}
          onChange={e => {
            setName(e.target.value);
            setErr(undefined);
            setDone(null);
          }}
          aria-invalid={!!err}
          aria-describedby={err ? `${id}-n-err` : undefined}
        />
        {err && (
          <span className="field-error" id={`${id}-n-err`} role="alert">
            {err}
          </span>
        )}
      </div>
      {enabled && (
        <CodexLoginFlow
          name={name}
          label={t('subscriptions.codex.signIn')}
          onStart={() => {
            const e = nameError(name, names);
            setErr(e);
            if (e) nameRef.current?.focus();
            return !e;
          }}
          onEnd={ok => {
            if (!ok) return;
            setDone(t('subscriptions.add.added', { name: name.trim() }));
            setName('');
          }}
        />
      )}
      {done && (
        <p className="hint" role="status">
          {done}
        </p>
      )}
    </section>
  );
}

/** The name check of the add form, before the token is read (H1): empty, too long, taken by an active one (any case). */
export function nameError(name: string, taken: string[]): string | undefined {
  const n = name.trim();
  if (!n || n.length > 60) return tNow('subscriptions.row.nameRange');
  const low = n.toLocaleLowerCase(currentLocale());
  if (taken.some(x => x.toLocaleLowerCase(currentLocale()) === low)) return tNow('subscriptions.error.nameTaken');
  return undefined;
}

function AddForm({ enabled, names, autoFocusName }: { enabled: boolean; names: string[]; autoFocusName: boolean }) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState('');
  const [auto, setAuto] = useState(false);
  // the token stays out of React state: its presence is tracked by the form's input events
  const [tokenTyped, setTokenTyped] = useState(false);
  useUnsavedInput(name.trim() !== '' || tokenTyped);
  const nameRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<{ name?: string; token?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  // L3: an empty registry opens with the cursor in «Имя» (the first render only)
  const focusOnOpen = useRef(autoFocusName && enabled);
  useEffect(() => {
    if (focusOnOpen.current) nameRef.current?.focus();
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDone(null);
    // H1: the name first — its error must not cost the pasted token
    const nameErr = nameError(name, names);
    if (nameErr) {
      setErrors({ name: nameErr });
      nameRef.current?.focus();
      return;
    }
    const token = peekToken(tokenRef);
    if (!subscriptionTokenSchema.safeParse(token).success) {
      setErrors({ token: token ? tokenFormat() : t('subscriptions.add.pasteToken') });
      tokenRef.current?.focus();
      return;
    }
    setErrors({});
    const n = name.trim();
    clearToken(tokenRef);
    setTokenTyped(false);
    setBusy(true);
    const r = await addSubscription(n, token, auto);
    setBusy(false);
    if (r.ok) {
      setName('');
      setAuto(false);
      setDone(t('subscriptions.add.added', { name: n }));
    } else setErrors({ [r.field ?? 'form']: r.message });
  };
  return (
    <form className="subs-add" aria-labelledby={`${id}-h`} onSubmit={e => void submit(e)} onInput={() => setTokenTyped(peekToken(tokenRef) !== '')} autoComplete="off">
      <h3 id={`${id}-h`} className="subs-h">
        {t('subscriptions.add.title')}
      </h3>
      <div className="row2">
        <div className="field">
          <label htmlFor={`${id}-n`}>{t('subscriptions.add.name')}</label>
          <input
            id={`${id}-n`}
            ref={nameRef}
            className="input"
            value={name}
            maxLength={60}
            disabled={!enabled}
            placeholder={t('subscriptions.add.namePlaceholder')}
            onChange={e => {
              setName(e.target.value);
              if (errors.name) setErrors(x => ({ ...x, name: undefined }));
            }}
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? `${id}-n-err` : undefined}
          />
          {errors.name && (
            <span className="field-error" id={`${id}-n-err`} role="alert">
              {errors.name}
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor={`${id}-t`}>{t('subscriptions.add.token')}</label>
          {enabled ? (
            <TokenInput id={`${id}-t`} inputRef={tokenRef} invalid={!!errors.token} describedBy={errors.token ? `${id}-t-err` : `${id}-t-hint`} />
          ) : (
            <input id={`${id}-t`} className="input" type="password" disabled autoComplete="off" />
          )}
          {errors.token ? (
            <span className="field-error" id={`${id}-t-err`} role="alert">
              {errors.token}
            </span>
          ) : (
            <span className="hint" id={`${id}-t-hint`}>
              {t('subscriptions.add.tokenHint')}
            </span>
          )}
        </div>
      </div>
      <div className="subs-add-foot">
        <label className="check">
          <input type="checkbox" checked={auto} disabled={!enabled} onChange={e => setAuto(e.target.checked)} /> {t('subscriptions.add.autoSwitch')}
        </label>
        <button type="submit" className="btn primary" disabled={!enabled || busy}>
          {busy ? t('subscriptions.add.adding') : t('subscriptions.add.add')}
        </button>
      </div>
      {errors.form && (
        <div className="err-box" role="alert">
          {errors.form}
        </div>
      )}
      {done && (
        <p className="hint" role="status">
          {done}
        </p>
      )}
    </form>
  );
}

type UsageRow = SubscriptionUsageResponse['rows'][number];
type UsageKey = keyof Omit<UsageRow, 'subscriptionId' | 'name'>;
const usageCols = (): Array<{ key: UsageKey; label: string }> => [
  { key: 'turns', label: tNow('subscriptions.usage.col.turns') },
  { key: 'inputTokens', label: tNow('subscriptions.usage.col.input') },
  { key: 'outputTokens', label: tNow('subscriptions.usage.col.output') },
  { key: 'cacheReadTokens', label: tNow('subscriptions.usage.col.cacheRead') },
  { key: 'cacheCreationTokens', label: tNow('subscriptions.usage.col.cacheWrite') },
  { key: 'limitHits', label: tNow('subscriptions.usage.col.limits') },
];

/** «21.10.2026 — 27.10.2026»: the interval the table counts, `to` exclusive (M8). */
export function rangeText(from: string, to: string): string | null {
  const f = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(f) || !Number.isFinite(end)) return null;
  const d = (ms: number) => fmt.date(ms, { day: '2-digit', month: '2-digit', year: 'numeric' });
  const a = d(f);
  const b = d(Math.max(f, end - 1));
  return a === b ? a : `${a} — ${b}`;
}

function Usage() {
  const t = useT();
  const COLS = usageCols();
  const USAGE_PERIODS = usagePeriods();
  const id = useId();
  const subs = useStore(s => s.subs);
  const [period, setPeriod] = useState<UsagePeriod>('7d');
  const today = localDate(new Date());
  const [from, setFrom] = useState(localDate(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(today);
  const [data, setData] = useState<SubscriptionUsageResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rangeErr, setRangeErr] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const range = usageRange(period, new Date(), { from, to });
    // M8: a bad period keeps the last table (dimmed) — the error says what to fix, the numbers do not vanish
    if ('error' in range) {
      setErr(range.error);
      setRangeErr(true);
      return;
    }
    let live = true;
    setLoading(true);
    setErr(null);
    setRangeErr(false);
    void loadUsage(range.from, range.to).then(r => {
      if (!live) return;
      setLoading(false);
      if ('error' in r) setErr(r.error);
      else setData(r);
    });
    return () => {
      live = false;
    };
  }, [period, from, to]);
  const periods = USAGE_PERIODS.map(p => p.value);
  const retiredIds = new Set(retiredSubs(subs).map(s => s.id));
  const total = data ? (Object.fromEntries(COLS.map(c => [c.key, data.rows.reduce((n, r) => n + r[c.key], 0)])) as Record<UsageKey, number>) : null;
  const shown = data ? rangeText(data.from, data.to) : null;
  const errId = `${id}-err`;
  return (
    <>
      <div className="field">
        <span className="lbl" id={`${id}-p`}>
          {t('subscriptions.usage.period')}
        </span>
        <div className="seg subs-periods" role="radiogroup" aria-labelledby={`${id}-p`} onKeyDown={e => rovingKey(e, periods, period, setPeriod)}>
          {USAGE_PERIODS.map(p => (
            <button
              key={p.value}
              type="button"
              role="radio"
              aria-checked={period === p.value}
              tabIndex={period === p.value ? 0 : -1}
              className={`seg-opt${period === p.value ? ' on' : ''}`}
              onClick={() => setPeriod(p.value)}
            >
              <b>{p.label}</b>
            </button>
          ))}
        </div>
      </div>
      {period === 'dates' && (
        <div className="row2">
          <div className="field">
            <label htmlFor={`${id}-f`}>{t('subscriptions.usage.from')}</label>
            <input
              id={`${id}-f`}
              type="date"
              className="input"
              value={from}
              max={today}
              onChange={e => setFrom(e.target.value)}
              aria-invalid={rangeErr && !from}
              aria-describedby={rangeErr && !from ? errId : undefined}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-to`}>{t('subscriptions.usage.to')}</label>
            <input
              id={`${id}-to`}
              type="date"
              className="input"
              value={to}
              max={today}
              onChange={e => setTo(e.target.value)}
              aria-invalid={rangeErr && !!from}
              aria-describedby={rangeErr && !!from ? errId : undefined}
            />
          </div>
        </div>
      )}
      {err && (
        <p className="field-error" id={errId} role="alert">
          {err}
        </p>
      )}
      {loading && !data && (
        <p className="hint" role="status">
          <span className="spinner" aria-hidden="true" /> {t('subscriptions.usage.calculating')}
        </p>
      )}
      {data &&
        (data.rows.length === 0 ? (
          <p className={`hint${err ? ' stale' : ''}`} role="status">
            {t('subscriptions.usage.none')}
          </p>
        ) : (
          <table className={`subs-usage${err ? ' stale' : ''}`} aria-busy={loading || !!err}>
            <caption>
              {shown && <b className="subs-range">{shown}. </b>}
              {t('subscriptions.usage.caption')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('subscriptions.field.label')}</th>
                {COLS.map(c => (
                  <th key={c.key} scope="col">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.subscriptionId ?? 'machine'} className={r.subscriptionId === null ? 'machine' : undefined}>
                  <th scope="row">
                    {r.subscriptionId === null ? t('subscriptions.usage.machineLogin') : r.name}
                    {r.subscriptionId !== null && retiredIds.has(r.subscriptionId) && <span className="pill subs-tag">{t('subscriptions.usage.retired')}</span>}
                  </th>
                  {COLS.map(c => (
                    <td key={c.key} data-label={c.label} className={c.key === 'limitHits' && r[c.key] > 0 ? 'warn' : undefined}>
                      {fmtInt(r[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {total && data.rows.length > 1 && (
              <tfoot>
                <tr>
                  <th scope="row">{t('subscriptions.usage.total')}</th>
                  {COLS.map(c => (
                    <td key={c.key} data-label={c.label}>
                      {fmtInt(total[c.key])}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        ))}
    </>
  );
}
