(() => {
  "use strict";
  const sb = window.supabase.createClient(FC_CONFIG.url, FC_CONFIG.anonKey);
  const $ = (id) => document.getElementById(id);
  const GENERAL = "00000000-0000-0000-0000-000000000001";
  const COLORS = ["#0F766E","#B45309","#7C3AED","#BE123C","#1D4ED8","#4D7C0F"];
  const GROUP_MS = 5 * 60 * 1000;
  const PHOTO_BUCKET = "chat-photos";
  const PHOTO_MAX_IN = 10 * 1024 * 1024;
  const PHOTO_MAX_EDGE = 2048;
  const PHOTO_QUALITY = 0.82;
  const RING_CIRC = 56.55;
  const RATIO_MIN = 0.8;
  const RATIO_MAX = 1.7778;
  if (FC_CONFIG.appName) document.title = FC_CONFIG.appName;
  if (FC_CONFIG.wordmark) $("wordmark").alt = FC_CONFIG.wordmark;
  let me = null, profiles = {}, convs = [], current = null, channel = null;
  let pendingPhoto = null, preparing = false, localSeq = 0;
  const inflight = new Map();
  const signedCache = new Map();

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function ico(name) { const s = el("span", "photo-ico " + name); s.setAttribute("aria-hidden", "true"); return s; }
  function colorFor(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }
  function nameFor(id) { return (profiles[id] && profiles[id].display_name) || "Someone"; }
  function avatar(id, label) { const a = el("span", "avatar", (label || "?").trim().charAt(0).toUpperCase()); a.style.background = id ? colorFor(id) : "#6b6f76"; return a; }
  function fmtShort(iso) {
    const d = new Date(iso), now = new Date();
    return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  function fmtTime(iso) {
    const d = new Date(iso), now = new Date();
    const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === now.toDateString() ? t : d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + t;
  }
  function show(screen) { $("login").classList.toggle("hidden", screen !== "login"); $("app").classList.toggle("hidden", screen !== "app"); }
  function previewOf(m) {
    const body = (m && m.body ? m.body : "").replace(/\s+/g, " ").trim();
    if (m && (m.photo_path || m.photo_local) && !body) return "sent a photo";
    return body;
  }
  function photoAlt(m) {
    const body = (m && m.body ? m.body : "").trim();
    return body || ("Photo from " + nameFor(m.user_id));
  }
  function clampRatio(w, h) {
    if (!w || !h) return RATIO_MIN;
    return Math.min(RATIO_MAX, Math.max(RATIO_MIN, w / h));
  }
  function applyFrame(frame, w, h) { frame.style.aspectRatio = String(clampRatio(w, h)); }
  function reducedMotion() { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
  function composerErr(msg) { $("composerErr").textContent = msg || ""; $("compose").classList.toggle("has-error", !!msg); }

  let toastTimer = null, toastRetry = null;
  function hideToast() { $("photoToast").classList.add("hidden"); toastRetry = null; if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; } }
  function showToast(msg, retryFn) {
    $("photoToastMsg").textContent = msg;
    $("photoToastRetry").classList.toggle("hidden", !retryFn);
    toastRetry = retryFn || null;
    $("photoToast").classList.remove("hidden");
    if (toastTimer) clearTimeout(toastTimer);
    if (!retryFn) toastTimer = setTimeout(hideToast, 5000);
  }
  $("photoToastRetry").addEventListener("click", () => { const fn = toastRetry; hideToast(); if (fn) fn(); });

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault(); $("loginErr").textContent = ""; $("loginBtn").disabled = true;
    const uname = $("email").value.trim();
    if (!/^[A-Za-z0-9._-]{3,20}$/.test(uname)) { $("loginBtn").disabled = false; $("loginErr").textContent = "Sign in failed. Check your username and password."; return; }
    const { error } = await sb.auth.signInWithPassword({ email: uname.toLowerCase() + "@users.friends-chat.local", password: $("password").value });
    $("loginBtn").disabled = false;
    if (error) $("loginErr").textContent = "Sign in failed. Check your username and password.";
  });

  sb.auth.onAuthStateChange((_ev, session) => {
    const uid = session && session.user ? session.user.id : null;
    if (uid && (!me || me.id !== uid)) { me = session.user; setTimeout(start, 0); }
    else if (!uid) { me = null; window.FC = null; $("adminView").classList.add("hidden"); $("adminBtn").classList.add("hidden"); teardown(); show("login"); }
  });

  function teardown() {
    inflight.forEach((item) => { try { if (item.xhr) item.xhr.abort(); } catch (_) {} });
    inflight.clear();
    if (channel) { sb.removeChannel(channel); channel = null; }
    current = null; convs = []; pendingPhoto = null; preparing = false; signedCache.clear();
    clearPhoto(); hideToast(); $("messages").replaceChildren(); $("convList").replaceChildren();
    if (!$("lightbox").classList.contains("hidden")) closeLightbox(true);
  }

  async function loadProfiles() {
    const { data, error } = await sb.from("profiles").select("id,username,display_name,color,is_admin");
    if (error) throw error; profiles = {}; data.forEach((p) => (profiles[p.id] = p));
    $("meName").textContent = "Signed in as " + nameFor(me.id);
    const isAdmin = !!(profiles[me.id] && profiles[me.id].is_admin);
    $("adminBtn").classList.toggle("hidden", !isAdmin);
    window.FC = { sb, me, isAdmin, openConv: (id) => { if (convs.some((c) => c.id === id)) openConv(id); else loadConvs().then(() => openConv(id)); }, reloadProfiles: async () => { await loadProfiles(); renderConvs(); setHeader(); } };
  }

  async function loadConvs() {
    const { data: mems, error } = await sb.from("conversation_members").select("conversation_id,user_id,last_read_at");
    if (error) throw error;
    const { data: cs, error: e2 } = await sb.from("conversations").select("id,name,is_dm,created_at");
    if (e2) throw e2;
    convs = await Promise.all(cs.map(async (c) => {
      const members = mems.filter((m) => m.conversation_id === c.id);
      const mine = members.find((m) => m.user_id === me.id);
      const other = c.is_dm ? (members.find((m) => m.user_id !== me.id) || {}).user_id : null;
      const { data: last } = await sb.from("messages").select("created_at,user_id,body,photo_path").eq("conversation_id", c.id).order("created_at", { ascending: false }).limit(1);
      const lastAt = last && last[0] ? last[0].created_at : null;
      const lastBy = last && last[0] ? last[0].user_id : null;
      const lastBody = last && last[0] ? previewOf(last[0]) : "";
      return { ...c, other, members: members.length, lastBody, lastBy, lastRead: mine ? mine.last_read_at : null, lastAt, unread: !!(lastAt && lastBy !== me.id && (!mine || lastAt > mine.last_read_at)) };
    }));
    convs.sort((a, b) => (a.id === GENERAL ? -1 : b.id === GENERAL ? 1 : (b.lastAt || b.created_at).localeCompare(a.lastAt || a.created_at)));
    renderConvs();
  }

  function setHeader() {
    if (!current) return;
    $("threadTitle").textContent = convTitle(current);
    $("threadSub").textContent = current.is_dm ? "Direct message" : current.members + (current.members === 1 ? " member" : " members");
  }
  function convTitle(c) { return c.is_dm ? nameFor(c.other) : (c.name || "Group"); }

  function renderConvs() {
    const list = $("convList"); list.replaceChildren();
    const q = $("search").value.trim().toLowerCase();
    convs.filter((c) => !q || convTitle(c).toLowerCase().includes(q)).forEach((c) => {
      const li = el("li"), b = el("button"); b.type = "button"; b.dataset.id = c.id;
      if (current && current.id === c.id) b.classList.add("active");
      const unread = c.unread && !(current && current.id === c.id);
      if (unread) b.classList.add("unread");
      const body = el("span", "cbody"), row = el("span", "crow"), prev = el("span", "cprev");
      row.append(el("span", "cname", convTitle(c)));
      if (c.lastAt) row.append(el("span", "ctime", fmtShort(c.lastAt)));
      const who = c.lastBody && c.lastBy === me.id ? "You: " : (c.lastBody && !c.is_dm ? nameFor(c.lastBy) + ": " : "");
      prev.append(el("span", null, c.lastBody ? who + c.lastBody.replace(/\s+/g, " ") : "No messages yet"));
      if (unread) { const d = el("span", "dot"); d.setAttribute("aria-label", "unread"); prev.append(d); }
      body.append(row, prev);
      b.append(avatar(c.is_dm ? c.other : null, c.is_dm ? convTitle(c) : "#"), body);
      b.addEventListener("click", () => openConv(c.id));
      li.append(b); list.append(li);
    });
  }

  async function signedUrl(path) {
    const hit = signedCache.get(path);
    if (hit && hit.exp > Date.now() + 60 * 1000) return hit.url;
    const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUrl(path, 3600);
    if (error || !data || !data.signedUrl) return null;
    signedCache.set(path, { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
    return data.signedUrl;
  }

  function ringSvg() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    const track = document.createElementNS(NS, "circle");
    track.setAttribute("cx", "12"); track.setAttribute("cy", "12"); track.setAttribute("r", "9");
    track.setAttribute("stroke", "rgba(255,255,255,0.25)");
    track.setAttribute("stroke-width", "2");
    const prog = document.createElementNS(NS, "circle");
    prog.setAttribute("class", "photo-ring-progress");
    prog.setAttribute("cx", "12"); prog.setAttribute("cy", "12"); prog.setAttribute("r", "9");
    prog.setAttribute("stroke", "#2DD4BF");
    prog.setAttribute("stroke-width", "2");
    prog.setAttribute("stroke-linecap", "round");
    prog.setAttribute("transform", "rotate(-90 12 12)");
    prog.setAttribute("stroke-dasharray", String(RING_CIRC));
    prog.setAttribute("stroke-dashoffset", String(RING_CIRC));
    svg.append(track, prog);
    return { svg, set: (p) => { prog.setAttribute("stroke-dashoffset", String(RING_CIRC * (1 - Math.max(0, Math.min(1, p))))); } };
  }

  function setMissing(frame, m) {
    frame.classList.add("is-missing");
    frame.classList.remove("is-loading", "is-sending", "is-failed");
    frame.replaceChildren();
    const box = el("div", "photo-missing");
    box.append(ico("alert"), el("p", null, "This photo is no longer available."));
    frame.append(box);
    m.missing = true;
  }

  function attachSending(frame, localId) {
    frame.classList.add("is-sending");
    const scrim = el("div", "photo-scrim");
    const wrap = el("button", "photo-ring-wrap");
    wrap.type = "button"; wrap.setAttribute("aria-label", "Cancel send");
    const ring = ringSvg();
    const x = el("span", "photo-cancel-x");
    wrap.append(ring.svg, x);
    wrap.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); cancelSend(localId); });
    scrim.append(wrap); frame.append(scrim);
    return ring;
  }

  function attachFailed(frame, localId) {
    frame.classList.remove("is-sending");
    frame.classList.add("is-failed");
    const existing = frame.querySelector(".photo-scrim, .photo-badge");
    if (existing && existing.classList.contains("photo-badge")) return;
    const scrim = frame.querySelector(".photo-scrim") || el("div", "photo-scrim");
    scrim.replaceChildren();
    if (!scrim.parentNode) frame.append(scrim);
    const badge = el("button", "photo-badge");
    badge.type = "button"; badge.setAttribute("aria-label", "Retry sending photo");
    const disc = el("span", "photo-badge-disc"); disc.append(ico("retry"));
    badge.append(disc);
    badge.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); retrySend(localId); });
    frame.append(badge);
  }

  function clearOverlays(frame) {
    frame.classList.remove("is-sending", "is-failed");
    frame.querySelectorAll(".photo-scrim, .photo-badge").forEach((n) => n.remove());
  }

  function bindPhoto(frame, img, m) {
    const btn = img.closest(".msg-photo-btn") || img;
    let retried = false;
    const ready = () => {
      frame.classList.remove("is-loading");
      img.style.opacity = "1";
      btn.setAttribute("aria-busy", "false");
      btn.setAttribute("aria-label", "View photo");
      applyFrame(frame, img.naturalWidth, img.naturalHeight);
      frame.querySelectorAll(".photo-blur, .photo-skeleton, .photo-wash").forEach((n) => n.remove());
    };
    const fail = () => {
      if (!retried && m.photo_path) {
        retried = true;
        signedCache.delete(m.photo_path);
        signedUrl(m.photo_path).then((url) => { if (url) img.src = url; else setMissing(frame, m); });
        return;
      }
      setMissing(frame, m);
    };
    img.addEventListener("load", ready);
    img.addEventListener("error", fail);
    if (img.complete && img.naturalWidth) ready();
    btn.addEventListener("click", (e) => {
      if (frame.classList.contains("is-missing") || frame.classList.contains("is-sending") || frame.classList.contains("is-failed")) return;
      e.preventDefault();
      openLightbox(img, m);
    });
  }

  function msgNode(m) {
    const mine = m.user_id === me.id, wrap = el("div", "msg" + (mine ? " mine" : ""));
    if (!mine) { wrap.append(el("span", "who", nameFor(m.user_id))); }
    const hasPhoto = !!(m.photo_path || m.photo_local || m.missing);
    const bubble = el("div", "bubble" + (hasPhoto ? " has-photo" : ""));
    if (hasPhoto) {
      const figure = el("figure", "photo-figure");
      const frame = el("div", "photo-frame");
      applyFrame(frame, m.photo_w, m.photo_h);
      if (m.missing) {
        setMissing(frame, m);
      } else {
        const btn = el("button", "msg-photo-btn"); btn.type = "button";
        btn.setAttribute("aria-busy", "true"); btn.setAttribute("aria-label", "Loading photo");
        const img = el("img", "msg-photo"); img.alt = photoAlt(m); img.draggable = false; img.decoding = "async";
        frame.classList.add("is-loading");
        if (m.photo_local && m.photo_local.preview) {
          frame.classList.add("has-preview");
          const blur = el("img", "photo-blur"); blur.src = m.photo_local.preview; blur.alt = "";
          frame.append(blur, el("div", "photo-wash"));
          img.src = m.photo_local.preview;
        } else {
          frame.append(el("div", "photo-skeleton"));
        }
        if (m.photo_path && !(m.photo_local && m.status === "sending")) {
          signedUrl(m.photo_path).then((url) => { if (url) img.src = url; else setMissing(frame, m); });
        }
        btn.append(img); frame.append(btn);
        bindPhoto(frame, img, m);
        if (m.status === "sending") {
          const ring = attachSending(frame, m.id);
          const item = inflight.get(m.id);
          if (item) item.ring = ring;
          if (m.progress) ring.set(m.progress);
        } else if (m.status === "failed") {
          attachFailed(frame, m.id);
        }
      }
      figure.append(frame);
      if (m.body) {
        const cap = el("figcaption", "caption", m.body);
        cap.setAttribute("aria-hidden", "true");
        figure.append(cap);
      }
      bubble.append(figure);
    } else {
      bubble.textContent = m.body;
    }
    wrap.append(bubble);
    const t = el("time", null, fmtTime(m.created_at)); t.dateTime = m.created_at; wrap.append(t);
    wrap.dataset.id = m.id; wrap.dataset.uid = m.user_id; wrap.dataset.at = m.created_at; return wrap;
  }
  function appendMsg(box, m) {
    const node = msgNode(m), prev = box.lastElementChild;
    if (prev && prev.classList.contains("msg") && prev.dataset.uid === String(m.user_id) && new Date(m.created_at) - new Date(prev.dataset.at) < GROUP_MS) {
      prev.classList.add("notlast"); node.classList.add("cont");
    }
    box.append(node);
    return node;
  }
  function nearBottom() { const b = $("messages"); return b.scrollHeight - b.scrollTop - b.clientHeight < 120; }
  function scrollBottom() { const b = $("messages"); b.scrollTop = b.scrollHeight; }
  function msgEl(id) { return $("messages").querySelector('.msg[data-id="' + id + '"]'); }

  async function markRead(id) {
    const c = convs.find((x) => x.id === id); if (c) c.unread = false;
    await sb.from("conversation_members").update({ last_read_at: new Date().toISOString() }).eq("conversation_id", id).eq("user_id", me.id);
  }

  async function openConv(id) {
    current = convs.find((c) => c.id === id); if (!current) return;
    history.replaceState(null, "", "#c=" + id); if (window.BackroomPush) BackroomPush.reportViewing();
    setHeader();
    $("app").classList.add("in-thread"); renderConvs();
    const box = $("messages"); box.replaceChildren();
    const { data, error } = await sb.from("messages").select("id,user_id,body,photo_path,created_at").eq("conversation_id", id).order("created_at", { ascending: false }).limit(200);
    if (error) { box.append(el("p", "empty", "Could not load messages.")); return; }
    if (!current || current.id !== id) return;
    if (!data.length) box.append(el("p", "empty", "No messages yet. Say hi."));
    data.reverse().forEach((m) => appendMsg(box, m));
    inflight.forEach((item) => { if (item.msg.conversation_id === id && !msgEl(item.msg.id) && !msgEl(item.msg.realId || "")) appendMsg(box, item.msg); });
    scrollBottom(); markRead(id);
    if (window.matchMedia("(min-width:760px)").matches) $("input").focus();
  }

  function onNewMessage(m) {
    const c = convs.find((x) => x.id === m.conversation_id);
    if (!c) { loadConvs(); return; }
    c.lastAt = m.created_at; c.lastBody = previewOf(m); c.lastBy = m.user_id;
    if (current && current.id === m.conversation_id) {
      const box = $("messages"); if (box.querySelector('[data-id="' + m.id + '"]')) return;
      const stick = nearBottom() || m.user_id === me.id;
      const empty = box.querySelector(".empty"); if (empty) empty.remove();
      appendMsg(box, m); if (stick) scrollBottom();
      if (document.visibilityState === "visible") markRead(m.conversation_id); else if (m.user_id !== me.id) c.unread = true;
    } else if (m.user_id !== me.id) c.unread = true;
    renderConvs();
  }

  function subscribe() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("messages-feed")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => onNewMessage(p.new))
      .subscribe();
  }

  async function start() {
    show("app");
    try {
      await loadProfiles(); await loadConvs(); subscribe();
      const want = (location.hash.match(/c=([0-9a-f-]{36})/) || [])[1];
      if (want && convs.some((c) => c.id === want)) openConv(want);
      else if (window.matchMedia("(min-width:760px)").matches) openConv(GENERAL);
    } catch (err) { console.warn("load failed", err && err.message); }
  }

  const input = $("input");
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; }
  function syncPlaceholder() {
    const staged = !!pendingPhoto || preparing || !$("photoPreview").classList.contains("hidden");
    input.placeholder = staged ? "Add a caption" : "Message";
  }
  function syncSend() {
    $("sendBtn").disabled = preparing || !(input.value.trim() || pendingPhoto);
    $("compose").classList.toggle("has-photo", !!pendingPhoto);
    syncPlaceholder();
  }

  async function loadBitmap(file) {
    if (typeof createImageBitmap === "function") {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
      catch (_) { /* fall through, including HEIC on some browsers */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = "async";
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error("decode")); img.src = url; });
      if (img.decode) { try { await img.decode(); } catch (_) {} }
      return img;
    } finally { URL.revokeObjectURL(url); }
  }

  async function compressPhoto(file) {
    if (file.size > PHOTO_MAX_IN) throw new Error("This photo is larger than 10 MB. Try a smaller one.");
    const type = (file.type || "").toLowerCase();
    const name = (file.name || "").toLowerCase();
    const looksImage = type.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif)$/.test(name);
    if (!looksImage) throw new Error("This photo type isn't supported. Try a JPEG or PNG.");
    let bmp;
    try { bmp = await loadBitmap(file); }
    catch (_) { throw new Error("This photo type isn't supported. Try a JPEG or PNG."); }
    try {
      let w = bmp.width || bmp.naturalWidth || 0, h = bmp.height || bmp.naturalHeight || 0;
      if (!w || !h) throw new Error("This photo type isn't supported. Try a JPEG or PNG.");
      const scale = Math.max(w, h) > PHOTO_MAX_EDGE ? PHOTO_MAX_EDGE / Math.max(w, h) : 1;
      w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
      if (!blob || !blob.size) throw new Error("Could not prepare that photo.");
      return { blob, mime: "image/jpeg", ext: "jpg", width: w, height: h };
    } finally { if (bmp && bmp.close) bmp.close(); }
  }

  function clearPhoto(revoke) {
    if (revoke !== false && pendingPhoto && pendingPhoto.preview) URL.revokeObjectURL(pendingPhoto.preview);
    pendingPhoto = null;
    $("photoInput").value = "";
    $("photoPreview").classList.add("hidden");
    $("photoBtn").classList.remove("active");
    $("photoPrep").classList.add("hidden");
    $("photoThumb").removeAttribute("src");
    $("photoMeta").textContent = "";
    syncSend();
  }

  function stagePhoto(photo) {
    if (pendingPhoto && pendingPhoto.preview && pendingPhoto.preview !== photo.preview) URL.revokeObjectURL(pendingPhoto.preview);
    pendingPhoto = photo;
    $("photoThumb").src = photo.preview;
    const kb = Math.max(1, Math.round(photo.blob.size / 1024));
    $("photoMeta").textContent = "Photo, " + kb + " KB";
    $("photoPrep").classList.add("hidden");
    $("photoPreview").classList.remove("hidden");
    $("photoBtn").classList.add("active");
    syncSend();
  }

  $("photoBtn").addEventListener("click", () => { if (!preparing) $("photoInput").click(); });
  $("photoClear").addEventListener("click", () => { if (!preparing) { clearPhoto(); composerErr(""); } });
  $("photoInput").addEventListener("change", async () => {
    const file = $("photoInput").files && $("photoInput").files[0];
    $("photoInput").value = "";
    if (!file) return;
    composerErr("");
    preparing = true; $("photoBtn").disabled = true; syncSend();
    $("photoPreview").classList.remove("hidden");
    $("photoBtn").classList.add("active");
    $("photoPrep").classList.remove("hidden");
    $("photoMeta").textContent = "Preparing photo...";
    const tempUrl = URL.createObjectURL(file);
    $("photoThumb").src = tempUrl;
    try {
      const prep = await compressPhoto(file);
      prep.preview = URL.createObjectURL(prep.blob);
      URL.revokeObjectURL(tempUrl);
      stagePhoto(prep);
    } catch (err) {
      URL.revokeObjectURL(tempUrl);
      clearPhoto();
      composerErr(err.message || "This photo type isn't supported. Try a JPEG or PNG.");
    } finally {
      preparing = false; $("photoBtn").disabled = false; syncSend();
    }
  });

  function uploadPhoto(path, blob, mime, onProgress) {
    let xhr;
    const promise = new Promise((resolve, reject) => {
      (async () => {
        const { data: sess } = await sb.auth.getSession();
        const token = sess && sess.session && sess.session.access_token;
        if (!token) { reject(new Error("Please sign in again.")); return; }
        xhr = new XMLHttpRequest();
        const item = [...inflight.values()].find((x) => x.pendingPath === path);
        if (item) item.xhr = xhr;
        xhr.open("POST", FC_CONFIG.url + "/storage/v1/object/" + PHOTO_BUCKET + "/" + path);
        xhr.setRequestHeader("Authorization", "Bearer " + token);
        xhr.setRequestHeader("apikey", FC_CONFIG.anonKey);
        xhr.setRequestHeader("Content-Type", mime);
        xhr.setRequestHeader("x-upsert", "false");
        xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error("upload"));
        };
        xhr.onerror = () => reject(new Error("upload"));
        xhr.onabort = () => reject(Object.assign(new Error("cancelled"), { cancelled: true }));
        xhr.send(blob);
      })().catch(reject);
    });
    return { promise, getXhr: () => xhr };
  }

  async function runSend(localId) {
    const item = inflight.get(localId);
    if (!item) return;
    const { msg, photo, body, convId } = item;
    msg.status = "sending";
    const node = msgEl(localId);
    const frame = node && node.querySelector(".photo-frame");
    if (frame && !frame.classList.contains("is-sending")) {
      clearOverlays(frame);
      item.ring = attachSending(frame, localId);
    }
    if (!item.uploadedPath) {
      const fileId = (crypto.randomUUID && crypto.randomUUID()) || null;
      if (!fileId) throw new Error("This browser can't send photos. Try Safari or Chrome.");
      const path = convId + "/" + me.id + "/" + fileId + ".jpg";
      item.pendingPath = path;
      const up = uploadPhoto(path, photo.blob, photo.mime, (p) => {
        msg.progress = p;
        if (item.ring) item.ring.set(p);
      });
      // xhr is attached inside the async opener; poll briefly
      const started = Date.now();
      while (!item.xhr && Date.now() - started < 2000) await new Promise((r) => setTimeout(r, 20));
      await up.promise;
      item.uploadedPath = path;
    }
    const row = { conversation_id: convId, body, photo_path: item.uploadedPath };
    const { data, error } = await sb.from("messages").insert(row).select("id,user_id,conversation_id,body,photo_path,created_at").single();
    if (error) throw Object.assign(new Error("insert"), { insertFailed: true });
    msg.status = "sent";
    msg.realId = data.id;
    msg.photo_path = data.photo_path;
    msg.created_at = data.created_at;
    const already = msgEl(data.id);
    if (node && already && already !== node) node.remove();
    else if (node) {
      node.dataset.id = String(data.id);
      node.dataset.at = data.created_at;
      const time = node.querySelector("time");
      if (time) { time.textContent = fmtTime(data.created_at); time.dateTime = data.created_at; }
      const frame2 = node.querySelector(".photo-frame");
      if (frame2) clearOverlays(frame2);
    }
    inflight.delete(localId);
    onNewMessage(data);
  }

  function failPhoto(localId, err) {
    const item = inflight.get(localId);
    if (!item) return;
    item.msg.status = "failed";
    const node = msgEl(localId);
    const frame = node && node.querySelector(".photo-frame");
    if (frame) attachFailed(frame, localId);
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    if (offline) showToast("You're offline. Try again when you're back.", () => retrySend(localId));
    else if (err && err.insertFailed) showToast("Message not sent. Please try again.", () => retrySend(localId));
    else showToast("Couldn't send the photo. Tap to try again.", () => retrySend(localId));
  }

  function cancelSend(localId) {
    const item = inflight.get(localId);
    if (!item) return;
    try { if (item.xhr) item.xhr.abort(); } catch (_) {}
    inflight.delete(localId);
    const node = msgEl(localId);
    if (node) node.remove();
    if (item.uploadedPath) { try { sb.storage.from(PHOTO_BUCKET).remove([item.uploadedPath]); } catch (_) {} }
    if (!pendingPhoto) stagePhoto(item.photo);
    hideToast();
  }

  function retrySend(localId) {
    const item = inflight.get(localId);
    if (!item) return;
    hideToast();
    runSend(localId).catch((err) => { if (!(err && err.cancelled)) failPhoto(localId, err); });
  }

  function startPhotoSend(convId, photo, body) {
    const localId = "local-" + (++localSeq);
    const msg = {
      id: localId, conversation_id: convId, user_id: me.id, body,
      photo_path: null, photo_local: photo, photo_w: photo.width, photo_h: photo.height,
      created_at: new Date().toISOString(), status: "sending", progress: 0,
    };
    const item = { msg, photo, body, convId, xhr: null, uploadedPath: null, ring: null };
    inflight.set(localId, item);
    if (current && current.id === convId) {
      const box = $("messages");
      const empty = box.querySelector(".empty"); if (empty) empty.remove();
      appendMsg(box, msg); scrollBottom();
    }
    const c = convs.find((x) => x.id === convId);
    if (c) { c.lastAt = msg.created_at; c.lastBody = previewOf(msg); c.lastBy = me.id; renderConvs(); }
    runSend(localId).catch((err) => { if (!(err && err.cancelled)) failPhoto(localId, err); });
  }

  input.addEventListener("input", () => { autosize(); syncSend(); });
  $("search").addEventListener("input", renderConvs);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(hover:hover)").matches) { e.preventDefault(); $("composer").requestSubmit(); }
  });
  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    const photo = pendingPhoto;
    if ((!body && !photo) || !current) return;
    composerErr(""); hideToast();
    if (photo) {
      input.value = ""; autosize();
      clearPhoto(false);
      startPhotoSend(current.id, photo, body);
      input.focus();
      return;
    }
    $("sendBtn").disabled = true;
    try {
      const { data, error } = await sb.from("messages").insert({ conversation_id: current.id, body }).select("id,user_id,conversation_id,body,photo_path,created_at").single();
      if (error) throw error;
      if (input.value.trim() === body) { input.value = ""; autosize(); }
      onNewMessage(data);
      input.focus();
    } catch (err) {
      composerErr("Message not sent. Please try again.");
    } finally { syncSend(); }
  });
  $("backBtn").addEventListener("click", () => { $("app").classList.remove("in-thread"); current = null; history.replaceState(null, "", location.pathname + location.search); if (window.BackroomPush) BackroomPush.reportViewing(); renderConvs(); });

  $("menuBtn").addEventListener("click", (e) => { e.stopPropagation(); $("menu").classList.toggle("hidden"); });
  document.addEventListener("click", (e) => { if (!$("menu").contains(e.target)) $("menu").classList.add("hidden"); });
  $("logoutBtn").addEventListener("click", async () => { try { if (window.BackroomPush) await window.BackroomPush.onLogout(); } catch (_) {} sb.auth.signOut(); });

  $("renameBtn").addEventListener("click", () => { $("menu").classList.add("hidden"); $("nameInput").value = nameFor(me.id); $("nameDialog").showModal(); });
  $("nameDialog").addEventListener("close", async () => {
    if ($("nameDialog").dataset.mode === "admin") return;
    if ($("nameDialog").returnValue !== "ok") return;
    const v = $("nameInput").value.trim().slice(0, 40); if (!v) return;
    const { error } = await sb.from("profiles").update({ display_name: v }).eq("id", me.id);
    if (error) { alert("Could not change your name."); return; }
    await loadProfiles(); renderConvs(); setHeader();
  });

  $("newDmBtn").addEventListener("click", () => {
    const list = $("memberList"); list.replaceChildren();
    Object.values(profiles).filter((p) => p.id !== me.id).sort((a, b) => a.display_name.localeCompare(b.display_name)).forEach((p) => {
      const li = el("li"), b = el("button"); b.type = "button";
      b.append(avatar(p.id, p.display_name), el("span", "cname", p.display_name));
      b.addEventListener("click", async () => {
        $("dmDialog").close();
        const { data, error } = await sb.rpc("get_or_create_dm", { other: p.id });
        if (error) { alert("Could not start the conversation."); return; }
        await loadConvs(); openConv(data);
      });
      li.append(b); list.append(li);
    });
    if (!list.children.length) list.append(el("li", "muted", "No other members yet."));
    $("dmDialog").showModal();
  });

  // Full-screen viewer
  const lightbox = $("lightbox"), lightImg = $("lightboxImg"), stage = $("lightboxStage"), bar = $("lightboxBar");
  const ZOOM_MAX = 4, ZOOM_DOUBLE = 2, DISMISS_PX = 80;
  let scale = 1, tx = 0, ty = 0, lastTap = 0, fitted = null, origin = null, returnFocus = null, hideBarTimer = null, viewerMsg = null, closing = false;
  function reduce() { return reducedMotion(); }
  function armBarHide() {
    if (hideBarTimer) clearTimeout(hideBarTimer);
    lightbox.classList.remove("bar-hidden");
    hideBarTimer = setTimeout(() => lightbox.classList.add("bar-hidden"), 2500);
  }
  function fittedBox(nw, nh) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const padTop = 88, padBot = 40;
    const availW = vw, availH = Math.max(100, vh - padTop - padBot);
    const r = Math.min(availW / nw, availH / nh);
    const w = nw * r, h = nh * r;
    return { left: (vw - w) / 2, top: padTop + (availH - h) / 2, width: w, height: h };
  }
  function place(box) {
    lightImg.style.left = box.left + "px"; lightImg.style.top = box.top + "px";
    lightImg.style.width = box.width + "px"; lightImg.style.height = box.height + "px";
    lightImg.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
  }
  function resetZoom() { scale = 1; tx = 0; ty = 0; if (fitted) place(fitted); else lightImg.style.transform = ""; }
  function closeLightbox(immediate) {
    if (lightbox.classList.contains("hidden") || closing) return;
    closing = true;
    if (hideBarTimer) { clearTimeout(hideBarTimer); hideBarTimer = null; }
    const done = () => {
      lightbox.classList.add("hidden"); lightbox.classList.remove("is-open", "bar-hidden");
      lightImg.removeAttribute("src"); lightImg.classList.remove("animating");
      scale = 1; tx = 0; ty = 0; fitted = null; origin = null; viewerMsg = null; closing = false;
      document.body.classList.remove("lightbox-open");
      if (returnFocus && returnFocus.focus) { try { returnFocus.focus(); } catch (_) {} }
      returnFocus = null;
    };
    if (immediate || reduce() || !origin || !fitted) {
      lightbox.classList.remove("is-open");
      setTimeout(done, reduce() || immediate ? 0 : 180);
      return;
    }
    lightImg.classList.add("animating");
    lightbox.classList.remove("is-open");
    place(origin);
    setTimeout(() => { lightImg.classList.remove("animating"); done(); }, 220);
  }
  function openLightbox(fromImg, m) {
    if (!fromImg || !fromImg.src || (m && m.missing)) return;
    returnFocus = document.activeElement;
    viewerMsg = m;
    scale = 1; tx = 0; ty = 0; closing = false;
    lightImg.alt = (m && photoAlt(m)) || fromImg.alt || "Photo";
    lightImg.src = fromImg.src;
    $("lightboxName").textContent = m ? nameFor(m.user_id) : "";
    $("lightboxTime").textContent = m ? fmtTime(m.created_at) : "";
    const canSave = !!(fromImg.src && !fromImg.src.startsWith("blob:"));
    $("lightboxSave").classList.toggle("hidden", !canSave && !fromImg.src);
    lightbox.classList.remove("hidden", "is-open", "bar-hidden");
    document.body.classList.add("lightbox-open");
    const r = fromImg.getBoundingClientRect();
    origin = { left: r.left, top: r.top, width: r.width, height: r.height };
    const nw = fromImg.naturalWidth || r.width, nh = fromImg.naturalHeight || r.height;
    fitted = fittedBox(nw, nh);
    if (reduce()) {
      place(fitted);
      requestAnimationFrame(() => lightbox.classList.add("is-open"));
    } else {
      place(origin);
      requestAnimationFrame(() => {
        lightImg.classList.add("animating");
        lightbox.classList.add("is-open");
        place(fitted);
        setTimeout(() => lightImg.classList.remove("animating"), 230);
      });
    }
    $("lightboxClose").focus();
    armBarHide();
  }
  $("lightboxClose").addEventListener("click", (e) => { e.stopPropagation(); closeLightbox(); });
  $("lightboxSave").addEventListener("click", async (e) => {
    e.stopPropagation(); armBarHide();
    try {
      const src = lightImg.src;
      if (!src) return;
      const res = await fetch(src);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "photo.jpg";
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (_) { $("lightboxSave").classList.add("hidden"); }
  });
  document.addEventListener("keydown", (e) => {
    if (lightbox.classList.contains("hidden")) return;
    if (e.key === "Escape") { e.preventDefault(); closeLightbox(); }
    if (e.key === "Tab") {
      const btns = [ $("lightboxSave"), $("lightboxClose") ].filter((b) => b && !b.classList.contains("hidden"));
      if (!btns.length) return;
      const i = btns.indexOf(document.activeElement);
      e.preventDefault();
      btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
    }
  });
  lightbox.addEventListener("click", (e) => { if (e.target === lightbox || e.target === stage || e.target === $("lightboxBg")) closeLightbox(); });
  stage.addEventListener("wheel", (e) => {
    if (lightbox.classList.contains("hidden")) return;
    e.preventDefault(); armBarHide();
    scale = Math.min(ZOOM_MAX, Math.max(1, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    if (scale === 1) { tx = 0; ty = 0; }
    if (fitted) place(fitted);
  }, { passive: false });

  let startDist = 0, startScale = 1, startTx = 0, startTy = 0, startX = 0, startY = 0, dragging = false, swiping = false, swipeDy = 0, moved = false;
  function touchDist(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
  stage.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap < 300) {
        e.preventDefault();
        if (scale > 1) { scale = 1; tx = 0; ty = 0; }
        else { scale = ZOOM_DOUBLE; }
        if (fitted) place(fitted);
        lastTap = 0; dragging = false; swiping = false; armBarHide(); return;
      }
      lastTap = now;
      moved = false;
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      startTx = tx; startTy = ty; swipeDy = 0;
      dragging = scale > 1;
      swiping = scale === 1;
    } else if (e.touches.length >= 2) {
      e.preventDefault();
      dragging = false; swiping = false;
      startDist = touchDist(e.touches[0], e.touches[1]);
      startScale = scale;
    }
  }, { passive: false });
  stage.addEventListener("touchmove", (e) => {
    if (e.touches.length >= 2) {
      e.preventDefault();
      swiping = false;
      scale = Math.min(ZOOM_MAX, Math.max(1, startScale * (touchDist(e.touches[0], e.touches[1]) / (startDist || 1))));
      if (scale === 1) { tx = 0; ty = 0; }
      if (fitted) place(fitted);
      moved = true;
    } else if (e.touches.length === 1 && dragging && scale > 1) {
      e.preventDefault();
      tx = startTx + (e.touches[0].clientX - startX);
      ty = startTy + (e.touches[0].clientY - startY);
      if (fitted) place(fitted);
      moved = true;
    } else if (e.touches.length === 1 && swiping && scale === 1) {
      const dy = e.touches[0].clientY - startY;
      if (Math.abs(dy) > 8) { e.preventDefault(); moved = true; swipeDy = Math.max(0, dy); lightImg.style.transform = "translate(0px," + swipeDy + "px) scale(1)"; $("lightboxBg").style.opacity = String(Math.max(0.4, 1 - swipeDy / 300)); }
    }
  }, { passive: false });
  stage.addEventListener("touchend", (e) => {
    if (e.touches.length === 0) {
      if (swiping && swipeDy >= DISMISS_PX) { $("lightboxBg").style.opacity = ""; closeLightbox(); }
      else if (swiping && swipeDy > 0) {
        lightImg.classList.add("animating");
        lightImg.style.transform = "translate(0px,0px) scale(1)";
        $("lightboxBg").style.opacity = "";
        setTimeout(() => lightImg.classList.remove("animating"), 230);
      }
      if (!moved && swiping) {
        // tap on the photo toggles the bar
        lightbox.classList.toggle("bar-hidden");
        if (!lightbox.classList.contains("bar-hidden")) armBarHide();
        else if (hideBarTimer) { clearTimeout(hideBarTimer); hideBarTimer = null; }
      } else if (moved) armBarHide();
      dragging = false; swiping = false; swipeDy = 0;
    }
  });

  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && me) { loadConvs(); if (current) markRead(current.id); } });
  sb.auth.getSession().then(({ data }) => { if (!data.session) show("login"); });
})();
