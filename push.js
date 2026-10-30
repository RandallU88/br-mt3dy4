(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  let reg = null;

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).then((r) => { reg = r; }).catch((e) => console.warn("sw register failed", e && e.message));
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "open-conversation" && e.data.conversation_id && window.FC) FC.openConv(e.data.conversation_id);
    });
  }

  // Tell the service worker which conversation is on screen so it can skip notifying for it.
  function reportViewing() {
    const c = document.visibilityState === "visible" ? ((location.hash.match(/c=([0-9a-f-]{36})/) || [])[1] || null) : null;
    if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: "viewing", conversation_id: c });
  }
  ["hashchange", "visibilitychange", "focus"].forEach((ev) => window.addEventListener(ev, reportViewing));
  document.addEventListener("visibilitychange", reportViewing);
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener("controllerchange", reportViewing);

  function b64ToBytes(s) { const p = "=".repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }
  function bufToB64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  async function getReg() { return reg || (reg = await navigator.serviceWorker.ready); }

  async function currentSub() { if (!supported) return null; const r = await getReg(); return r.pushManager.getSubscription(); }
  async function myRow(sub) {
    if (!sub || !window.FC) return null;
    const { data } = await FC.sb.from("push_subscriptions").select("muted_general").eq("endpoint", sub.endpoint).maybeSingle();
    return data;
  }

  async function render() {
    const status = $("notifStatus"), help = $("notifHelp"), en = $("notifEnable"), dis = $("notifDisable"), mute = $("muteGeneral");
    $("notifMsg").textContent = ""; help.textContent = "";
    let state = "Off";
    if (isIOS && !standalone) { state = "Add Backroom to your Home Screen first"; help.textContent = "In Safari tap Share, then Add to Home Screen. Open Backroom from the new icon and come back here."; }
    else if (!supported) { state = "Not supported on this browser"; }
    else if (Notification.permission === "denied") { state = "Blocked"; help.textContent = isIOS ? "Turn them on in Settings > Notifications > Backroom." : "Allow notifications for this site in your browser settings."; }
    else {
      const sub = await currentSub(); const row = await myRow(sub);
      if (sub && row && Notification.permission === "granted") { state = "On"; mute.checked = !!row.muted_general; }
    }
    status.textContent = state;
    const on = state === "On";
    en.classList.toggle("hidden", on || state.startsWith("Add") || state.startsWith("Not") || state === "Blocked");
    dis.classList.toggle("hidden", !on); mute.parentElement.classList.toggle("hidden", !on);
    return state;
  }

  async function enable() {
    $("notifEnable").disabled = true;
    try {
      const perm = await Notification.requestPermission();   // called directly from the tap
      if (perm !== "granted") { await render(); return; }
      const r = await getReg();
      let sub = await r.pushManager.getSubscription();
      if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(FC_CONFIG.vapidPublicKey) });
      const { error } = await FC.sb.rpc("save_push_subscription", { p_endpoint: sub.endpoint, p_p256dh: bufToB64(sub.getKey("p256dh")), p_auth: bufToB64(sub.getKey("auth")), p_muted_general: $("muteGeneral").checked });
      if (error) throw error;
      await render();
    } catch (e) { $("notifMsg").textContent = "Could not turn on notifications. " + ((e && e.message) || ""); }
    finally { $("notifEnable").disabled = false; }
  }

  async function disable() {
    try {
      const sub = await currentSub();
      if (sub) { await FC.sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
    } catch (e) { $("notifMsg").textContent = "Could not turn off notifications."; }
    await render();
  }

  $("notifBtn").addEventListener("click", async () => { $("menu").classList.add("hidden"); $("notifDialog").showModal(); await render(); });
  $("notifEnable").addEventListener("click", enable);
  $("notifDisable").addEventListener("click", disable);
  $("muteGeneral").addEventListener("change", async () => {
    const sub = await currentSub(); if (!sub) return;
    const { error } = await FC.sb.from("push_subscriptions").update({ muted_general: $("muteGeneral").checked }).eq("endpoint", sub.endpoint);
    if (error) $("notifMsg").textContent = "Could not save that setting.";
  });
  // Signing out stops notifications on this device so the next person here doesn't get someone else's.
  async function onLogout() { const sub = await currentSub(); if (sub) { await FC.sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); } }
  window.BackroomPush = { render, onLogout, reportViewing };
})();
