(() => {
  "use strict";
  const sb = window.supabase.createClient(FC_CONFIG.url, FC_CONFIG.anonKey);
  const $ = (id) => document.getElementById(id);
  const GENERAL = "00000000-0000-0000-0000-000000000001";
  const COLORS = ["#0F766E","#B45309","#7C3AED","#BE123C","#1D4ED8","#4D7C0F"];
  const GROUP_MS = 5 * 60 * 1000;
  if (FC_CONFIG.appName) document.title = FC_CONFIG.appName;
  if (FC_CONFIG.wordmark) $("wordmark").alt = FC_CONFIG.wordmark;
  let me = null, profiles = {}, convs = [], current = null, channel = null;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
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

  function teardown() { if (channel) { sb.removeChannel(channel); channel = null; } current = null; convs = []; $("messages").replaceChildren(); $("convList").replaceChildren(); }

  async function loadProfiles() {
    const { data, error } = await sb.from("profiles").select("id,username,display_name,color,is_admin");
    if (error) throw error; profiles = {}; data.forEach((p) => (profiles[p.id] = p));
    $("meName").textContent = "Signed in as " + nameFor(me.id);
    const isAdmin = !!(profiles[me.id] && profiles[me.id].is_admin);
    $("adminBtn").classList.toggle("hidden", !isAdmin);
    window.FC = { sb, me, isAdmin, reloadProfiles: async () => { await loadProfiles(); renderConvs(); setHeader(); } };
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
      const { data: last } = await sb.from("messages").select("created_at,user_id,body").eq("conversation_id", c.id).order("created_at", { ascending: false }).limit(1);
      const lastAt = last && last[0] ? last[0].created_at : null;
      const lastBy = last && last[0] ? last[0].user_id : null;
      const lastBody = last && last[0] ? last[0].body : "";
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

  function msgNode(m) {
    const mine = m.user_id === me.id, wrap = el("div", "msg" + (mine ? " mine" : ""));
    if (!mine) { wrap.append(el("span", "who", nameFor(m.user_id))); }
    wrap.append(el("div", "bubble", m.body));
    const t = el("time", null, fmtTime(m.created_at)); t.dateTime = m.created_at; wrap.append(t);
    wrap.dataset.id = m.id; wrap.dataset.uid = m.user_id; wrap.dataset.at = m.created_at; return wrap;
  }
  function appendMsg(box, m) {
    const node = msgNode(m), prev = box.lastElementChild;
    if (prev && prev.classList.contains("msg") && prev.dataset.uid === m.user_id && new Date(m.created_at) - new Date(prev.dataset.at) < GROUP_MS) {
      prev.classList.add("notlast"); node.classList.add("cont");
    }
    box.append(node);
  }
  function nearBottom() { const b = $("messages"); return b.scrollHeight - b.scrollTop - b.clientHeight < 120; }
  function scrollBottom() { const b = $("messages"); b.scrollTop = b.scrollHeight; }

  async function markRead(id) {
    const c = convs.find((x) => x.id === id); if (c) c.unread = false;
    await sb.from("conversation_members").update({ last_read_at: new Date().toISOString() }).eq("conversation_id", id).eq("user_id", me.id);
  }

  async function openConv(id) {
    current = convs.find((c) => c.id === id); if (!current) return;
    setHeader();
    $("app").classList.add("in-thread"); renderConvs();
    const box = $("messages"); box.replaceChildren();
    const { data, error } = await sb.from("messages").select("id,user_id,body,created_at").eq("conversation_id", id).order("created_at", { ascending: false }).limit(200);
    if (error) { box.append(el("p", "empty", "Could not load messages.")); return; }
    if (!current || current.id !== id) return;
    if (!data.length) box.append(el("p", "empty", "No messages yet. Say hi."));
    data.reverse().forEach((m) => appendMsg(box, m));
    scrollBottom(); markRead(id);
    if (window.matchMedia("(min-width:760px)").matches) $("input").focus();
  }

  function onNewMessage(m) {
    const c = convs.find((x) => x.id === m.conversation_id);
    if (!c) { loadConvs(); return; }
    c.lastAt = m.created_at; c.lastBody = m.body; c.lastBy = m.user_id;
    if (current && current.id === m.conversation_id) {
      const box = $("messages"); if (box.querySelector(`[data-id="${m.id}"]`)) return;
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
      if (window.matchMedia("(min-width:760px)").matches) openConv(GENERAL);
    } catch (err) { console.warn("load failed", err && err.message); }
  }

  const input = $("input");
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; }
  function syncSend() { $("sendBtn").disabled = !input.value.trim(); }
  input.addEventListener("input", () => { autosize(); syncSend(); });
  $("search").addEventListener("input", renderConvs);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(hover:hover)").matches) { e.preventDefault(); $("composer").requestSubmit(); }
  });
  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault(); const body = input.value.trim(); if (!body || !current) return;
    $("sendBtn").disabled = true;
    const { data, error } = await sb.from("messages").insert({ conversation_id: current.id, body }).select("id,user_id,conversation_id,body,created_at").single();
    syncSend();
    if (error) { alert("Message not sent. Please try again."); return; }
    input.value = ""; autosize(); syncSend(); onNewMessage(data); input.focus();
  });
  $("backBtn").addEventListener("click", () => { $("app").classList.remove("in-thread"); current = null; renderConvs(); });

  $("menuBtn").addEventListener("click", (e) => { e.stopPropagation(); $("menu").classList.toggle("hidden"); });
  document.addEventListener("click", (e) => { if (!$("menu").contains(e.target)) $("menu").classList.add("hidden"); });
  $("logoutBtn").addEventListener("click", () => sb.auth.signOut());

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

  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && me) { loadConvs(); if (current) markRead(current.id); } });
  sb.auth.getSession().then(({ data }) => { if (!data.session) show("login"); });
})();
