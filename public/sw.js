// Service worker do Manager: só mostra notificações (Android e app instalado não aceitam `new Notification`).
// Não guarda cache: a UI continua vindo sempre do servidor.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Web push vindo do servidor (iPhone e app fechado). O iOS exige mostrar uma notificação a cada push.
self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data?.json() || {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Manager", { body: d.body || "", tag: d.tag, icon: "/favicon.svg", data: { conv: d.conv } }));
});

// Toque na notificação: foca a janela aberta (ou abre uma) e pede para abrir a conversa.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const conv = e.notification.data?.conv;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins[0];
    if (w) { await w.focus(); if (conv) w.postMessage({ type: "open-conv", conv }); return; }
    await self.clients.openWindow(conv ? "/?conv=" + encodeURIComponent(conv) : "/");
  })());
});
