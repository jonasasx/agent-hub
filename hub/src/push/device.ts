// The label of a device in the list of subscriptions: «browser · system» by User-Agent (D5). A proper name, not translated.
const MAX = 100;

function browserOf(ua: string): string {
  if (/Agent ?Hub|Electron\//i.test(ua)) return 'Agent Hub app';
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/YaBrowser\//.test(ua)) return 'Yandex Browser';
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

function systemOf(ua: string): string | null {
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return null;
}

export function deviceLabel(ua: string | undefined): string {
  if (!ua || !ua.trim()) return 'Unknown device';
  const browser = browserOf(ua);
  const system = systemOf(ua);
  const label = system ? `${browser} · ${system}` : browser;
  return label.slice(0, MAX);
}
