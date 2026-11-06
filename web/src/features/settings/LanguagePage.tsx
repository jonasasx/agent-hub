// «Настройки → Язык»: the interface language. The choice applies at once on this device and is saved in the profile.
import { useState } from 'react';
import { LOCALES, type Locale } from '@agent-hub/shared';
import { api, ApiError } from '../../api/client';
import { browserLocale, chooseLocale, useLocale, useT } from '../../i18n';
import { useStore } from '../../store';

const nameOf = (id: Locale): string => LOCALES.find(l => l.id === id)?.name ?? id;

export function LanguagePage() {
  const t = useT();
  const chosen = useLocale(s => s.chosen);
  const pushToast = useStore(s => s.pushToast);
  // one save at a time: a late failure of an older click would otherwise roll back a newer choice
  const [busy, setBusy] = useState(false);

  const choose = async (locale: Locale | null) => {
    if (busy) return;
    setBusy(true);
    const prev = useLocale.getState().chosen;
    await chooseLocale(locale);
    try {
      await api.setLocale(locale);
    } catch (e) {
      // the profile keeps the old language: so does the device, otherwise the next sign-in switches it back
      await chooseLocale(prev);
      const text = e instanceof ApiError && e.serverMessage ? e.serverMessage : t('settings.language.saveFailedText');
      pushToast({ title: t('settings.language.saveFailedTitle'), text, color: 'var(--bad)' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="set-language">
      <div className="set-head">
        <h2 id="set-language">{t('settings.language.title')}</h2>
      </div>
      <p className="hint">{t('settings.language.hint')}</p>
      <div className="lang-list" role="radiogroup" aria-label={t('settings.language.group')} aria-busy={busy}>
        <label className={`lang-opt${chosen === null ? ' on' : ''}`}>
          <input type="radio" name="ui-locale" checked={chosen === null} onChange={() => void choose(null)} />
          <span>
            {t('settings.language.browser')}
            <span className="hint"> · {t('settings.language.browserNow', { language: nameOf(browserLocale()) })}</span>
          </span>
        </label>
        {LOCALES.map(l => (
          <label key={l.id} className={`lang-opt${chosen === l.id ? ' on' : ''}`}>
            <input type="radio" name="ui-locale" checked={chosen === l.id} onChange={() => void choose(l.id)} />
            <span lang={l.id}>{l.name}</span>
          </label>
        ))}
      </div>
    </section>
  );
}
