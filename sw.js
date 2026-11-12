// Service worker : permet à l'application de fonctionner hors connexion
// et récupère toujours la dernière version publiée quand il y a du réseau.
const CACHE = 'budget-hebdo-v15';
const ASSETS = ['./', './index.html', './app.js', './config.js', './styles.css', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon.png'];
self.addEventListener('install', e => {
  // cache: 'reload' = on ignore le cache du navigateur pour prendre les fichiers tout juste publiés
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // Réseau d'abord, en revalidant auprès du serveur (pas de vieille copie), sinon le cache si hors ligne
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(ca => ca.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
