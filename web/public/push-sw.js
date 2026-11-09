// Web Push handlers (change web-push-notifications, design D8). Loaded into the generated sw.js by workbox importScripts;
// plain JS, no build step. Every push shows a notification (iOS revokes the subscription otherwise).
'use strict';

const OPEN_SESSION = 'agent-hub:open-session';

self.addEventListener('push', event => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  if (!data || typeof data !== 'object') data = {};
  const title = typeof data.title === 'string' && data.title ? data.title : 'Agent Hub';
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : undefined;
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag,
    renotify: Boolean(tag),
    icon: '/icons/icon-192.png',
    lang: typeof data.lang === 'string' ? data.lang : undefined,
    data: { sessionId: typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

async function openFromNotification(sessionId) {
  const target = sessionId ? '/s/' + sessionId : '/';
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const sameOrigin = all.filter(c => String(c.url).startsWith(self.location.origin));
  const client = sameOrigin.find(c => c.focused) || sameOrigin.find(c => c.visibilityState === 'visible') || sameOrigin[0];
  if (client) {
    try {
      await client.focus();
      if (sessionId) client.postMessage({ type: OPEN_SESSION, sessionId });
      return;
    } catch {
      // the window went away or cannot be focused: open a new one below
    }
  }
  await self.clients.openWindow(target);
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const sessionId = event.notification.data && typeof event.notification.data.sessionId === 'string' ? event.notification.data.sessionId : null;
  event.waitUntil(openFromNotification(sessionId));
});
