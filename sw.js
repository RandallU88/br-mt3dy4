/* Backroom service worker: Web Push only (no offline caching). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// What each open window is showing, reported by the page (WindowClient.url doesn't follow hash changes).
const viewing = new Map();
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "viewing" && e.source) viewing.set(e.source.id, e.data.conversation_id || null);
});
function convFromUrl(u) { try { return new URL(u).hash.match(/c=([0-9a-f-]{36})/)?.[1] || null; } catch (_) { return null; } }

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let d = {};
    try { d = event.data ? event.data.json() : {}; } catch (_) { d = { title: "Backroom", body: event.data ? event.data.text() : "" }; }
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Is this conversation already on screen? (visibility, not focus: focus is unreliable in iOS standalone apps)
    const onScreen = !!d.conversation_id && wins.some((w) => w.visibilityState === "visible" && (viewing.has(w.id) ? viewing.get(w.id) : convFromUrl(w.url)) === d.conversation_id);
    const tag = d.tag || "backroom";
    // One notification per conversation: clear the older ones first (Safari ignores tag replacement).
    try { (await self.registration.getNotifications({ tag })).forEach((n) => n.close()); } catch (_) { /* unsupported */ }
    // Browsers require every push to show a notification (Safari and Chrome can cancel the subscription after
    // silent pushes), so when the conversation is already on screen we show it and close it right away.
    // The server already skips people viewing the conversation, so this is only a fallback.
    await self.registration.showNotification(d.title || "Backroom", {
      body: d.body || "",
      icon: "brand/icon-192.png",
      badge: "brand/favicon-32.png",
      tag,
      renotify: !onScreen,
      silent: onScreen,
      data: { conversation_id: d.conversation_id || null, message_id: d.message_id || null },
    });
    if (onScreen) (await self.registration.getNotifications({ tag })).forEach((n) => n.close());
    // Badge = unread conversations, sent by the server (not a count of notifications on the device).
    if (!onScreen && "setAppBadge" in self.navigator) {
      try { const n = typeof d.badge === "number" ? d.badge : 1; await (n > 0 ? self.navigator.setAppBadge(n) : self.navigator.clearAppBadge()); } catch (_) { /* unsupported */ }
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const cid = event.notification.data && event.notification.data.conversation_id;
  const target = new URL(cid ? "./#c=" + cid : "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        w.postMessage({ type: "open-conversation", conversation_id: cid });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
