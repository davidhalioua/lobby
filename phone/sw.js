// Service worker : affiche « Partie trouvée » même téléphone verrouillé, et permet d'accepter
// depuis la notification (Android ; sur iPhone, toucher la notification ouvre Lobby).
const token = new URL(self.location).searchParams.get('t');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { /* push sans contenu */ }
  const accepted = data.kind === 'accepted';
  e.waitUntil(self.registration.showNotification(accepted ? 'Partie acceptée ✓' : 'Partie trouvée !', {
    body: accepted ? "L'auto-accept s'en est chargé. Ouvre Lobby pour la sélection." : 'Touche pour accepter.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'lobby-ready',
    renotify: true,
    requireInteraction: !accepted,
    vibrate: [300, 150, 300, 150, 300],
    actions: accepted ? [] : [{ action: 'accept', title: 'Accepter' }, { action: 'decline', title: 'Refuser' }],
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    if (e.action === 'accept' || e.action === 'decline') {
      await fetch('/api/cmd', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: token, cmd: { cmd: e.action } }),
      }).catch(() => {});
      if (e.action === 'decline') return;
    }
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins[0]) return wins[0].focus();
    return self.clients.openWindow(`/?t=${encodeURIComponent(token)}`);
  })());
});
