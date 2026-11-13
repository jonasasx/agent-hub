// «Настройки → Приложение» (change desktop-download, D8): the Windows installer of this hub. The hub names the file
// with its own host, and the installed app connects to the hub it was downloaded from.
import { useT } from '../../i18n';
import { useStore } from '../../store';
import { formatBytes } from '../images/format';

export function DesktopPage() {
  const t = useT();
  const info = useStore(s => s.desktopInfo);
  if (!info?.available) return null;
  return (
    <section aria-labelledby="set-desktop">
      <div className="set-head">
        <h2 id="set-desktop">{t('settings.desktop.title')}</h2>
      </div>
      <p className="hint">{t('settings.desktop.hint')}</p>
      <p>
        <a className="btn primary" href="/api/desktop/download" download={info.fileName} data-testid="desktop-download">
          {t('settings.desktop.download')}
        </a>
      </p>
      <p className="hint">{t('settings.desktop.version', { version: info.version, size: formatBytes(info.size) })}</p>
    </section>
  );
}
