/**
 * The app's own screens: «Нет связи» (D14), «Нужен вход», «Вход в браузере», «Ошибка входа» (desktop-auth).
 * Static HTML without scripts (CSP `default-src 'none'`), loaded by the main process as a `data:` URL; the buttons are
 * plain links to the hub, which the navigation policy (D3) allows (`/auth/login` → sign-in through the browser).
 */
import { currentLocale, dt } from './i18n.js';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

const STYLE = `
:root{color-scheme:light dark}
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:15px/1.5 "Segoe UI",system-ui,sans-serif;background:#f6f6f4;color:#1d1d1b}
@media (prefers-color-scheme:dark){body{background:#1b1b1a;color:#e8e8e4}.hub{color:#9a9a94}a.btn{background:#e8e8e4;color:#1b1b1a}}
main{max-width:440px;padding:32px;text-align:center}
h1{font-size:20px;font-weight:600;margin:0 0 8px}
p{margin:0 0 20px}
.hub{color:#6b6b66;font-size:13px;word-break:break-all}
a.btn{display:inline-block;padding:8px 20px;border-radius:6px;background:#1d1d1b;color:#fff;text-decoration:none;font-weight:500}
a.btn:focus-visible{outline:2px solid #4a7fd6;outline-offset:2px}
`;

function page(title: string, heading: string, text: string, hubUrl: string, button: { href: string; label: string } | null): string {
  const btn = button ? `<a class="btn" href="${escapeHtml(button.href)}">${escapeHtml(button.label)}</a>` : '';
  return `<!doctype html><html lang="${currentLocale()}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main role="main"><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(text)}</p><p class="hub">${escapeHtml(hubUrl)}</p>${btn}</main></body></html>`;
}

export function toDataUrl(html: string): string {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
}

/** «Нет связи с хабом — проверьте VPN», «Повторить» → the remembered hub address. */
export function offlinePage(hubUrl: string, retryUrl: string): string {
  return page(dt('desktop.pages.offline.window'), dt('desktop.pages.offline.heading'), dt('desktop.pages.offline.text'), hubUrl, {
    href: retryUrl,
    label: dt('desktop.pages.offline.retry'),
  });
}

function loginHref(hubUrl: string, returnPath: string): string {
  return `${hubUrl}/auth/login?return=${encodeURIComponent(returnPath)}`;
}

export function signInPage(hubUrl: string, returnPath: string): string {
  return page(dt('desktop.pages.signIn.window'), dt('desktop.pages.signIn.heading'), dt('desktop.pages.signIn.text'), hubUrl, {
    href: loginHref(hubUrl, returnPath),
    label: dt('desktop.pages.signIn.button'),
  });
}

export function loginPendingPage(hubUrl: string, returnPath: string): string {
  return page(dt('desktop.pages.pending.window'), dt('desktop.pages.pending.heading'), dt('desktop.pages.pending.text'), hubUrl, {
    href: loginHref(hubUrl, returnPath),
    label: dt('desktop.pages.pending.button'),
  });
}

export function loginErrorPage(hubUrl: string, returnPath: string, message: string): string {
  return page(dt('desktop.pages.error.window'), dt('desktop.pages.error.heading'), message, hubUrl, {
    href: loginHref(hubUrl, returnPath),
    label: dt('desktop.pages.error.button'),
  });
}
