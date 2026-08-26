// Minimal service worker: its presence satisfies Chrome's PWA install
// criteria. The empty fetch handler keeps default network behaviour — no
// caching, so a new release is always what users see.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
