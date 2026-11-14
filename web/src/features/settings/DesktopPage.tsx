// «Настройки → Приложение» (change desktop-download, D8; desktop-platforms): installers of this hub for Windows, Linux and
// macOS. The hub names the Windows and Linux files with its own host, so the installed app connects to the hub it was
// downloaded from; on macOS the app is connected by the agenthub://connect link.
import { useT } from '../../i18n';
import { useStore } from '../../store';
import { formatBytes } from '../images/format';
import type { DesktopPlatform } from '@agent-hub/shared';

const DOWNLOAD_LABEL: Record<DesktopPlatform, 'settings.desktop.download' | 'settings.desktop.downloadLinux' | 'settings.desktop.downloadMac'> = {
  win: 'settings.desktop.download',
  linux: 'settings.desktop.downloadLinux',
  mac: 'settings.desktop.downloadMac',
};

export function DesktopPage() {
  const t = useT();
  const info = useStore(s => s.desktopInfo);
  if (!info?.available) return null;
  const hasMac = info.downloads.some(d => d.platform === 'mac');
  return (
    <section aria-labelledby="set-desktop">
      <div className="set-head">
        <h2 id="set-desktop">{t('settings.desktop.title')}</h2>
      </div>
      <p className="hint">{t('settings.desktop.hint')}</p>
      <p>
        {info.downloads.map(d => (
          <a
            key={d.platform}
            className="btn primary"
            href={`/api/desktop/download?platform=${d.platform}`}
            download={d.fileName}
            data-testid={`desktop-download-${d.platform}`}
            style={{ marginRight: 8 }}
          >
            {t(DOWNLOAD_LABEL[d.platform])}
          </a>
        ))}
      </p>
      <p className="hint">{t('settings.desktop.version', { version: info.version, size: formatBytes(info.size) })}</p>
      {hasMac && (
        <>
          <p className="hint">{t('settings.desktop.macHint')}</p>
          <p>
            <a className="btn" href={`agenthub://connect?hub=${encodeURIComponent(window.location.origin)}`} data-testid="desktop-connect">
              {t('settings.desktop.connect')}
            </a>
          </p>
          <p className="hint">{t('settings.desktop.connectHint')}</p>
        </>
      )}
    </section>
  );
}
