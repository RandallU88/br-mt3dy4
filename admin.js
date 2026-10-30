(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const FN = FC_CONFIG.url + "/functions/v1/admin-users";
  const fmt = (iso) => iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never";

  async function call(action, payload = {}) {
    const { data } = await FC.sb.auth.getSession();
    const token = data.session && data.session.access_token;
    const r = await fetch(FN, { method: "POST", headers: { "Content-Type": "application/json", apikey: FC_CONFIG.anonKey, Authorization: "Bearer " + token }, body: JSON.stringify({ action, ...payload }) });
    let body = {}; try { body = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(body.error || "Request failed (" + r.status + ").");
    return body;
  }

  function toggle(btn, input) {
    btn.addEventListener("click", () => {
      const show = input.type === "password"; input.type = show ? "text" : "password";
      btn.textContent = show ? "Hide" : "Show"; btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    });
  }
  toggle($("newPwToggle"), $("newPw")); toggle($("pwToggle"), $("pwInput"));

  // ---- password dialog (self or admin reset) ----
  let pwTarget = null;
  function openPw(target) {
    pwTarget = target; $("pwInput").value = ""; $("pwInput").type = "password"; $("pwToggle").textContent = "Show"; $("pwMsg").textContent = "";
    $("pwMsg").className = "err";
    $("pwTitle").textContent = target ? "Reset password for " + target : "Change my password";
    $("pwDialog").showModal();
  }
  $("pwBtn").addEventListener("click", () => { $("menu").classList.add("hidden"); openPw(null); });
  $("pwForm").addEventListener("submit", async (e) => {
    if (e.submitter && e.submitter.value === "cancel") return;
    e.preventDefault();
    const pw = $("pwInput").value;
    if (pw.length < 8) { $("pwMsg").textContent = "Use at least 8 characters."; return; }
    $("pwSave").disabled = true;
    try {
      if (pwTarget) await call("reset", { username: pwTarget, password: pw });
      else { const { error } = await FC.sb.auth.updateUser({ password: pw }); if (error) throw new Error(error.message.includes("different") ? "Pick a password different from your current one." : "Could not change password."); }
      $("pwInput").value = ""; $("pwDialog").close();
      flash(pwTarget ? "Password reset for " + pwTarget + "." : "Your password was changed.");
    } catch (err) { $("pwMsg").textContent = err.message; }
    finally { $("pwSave").disabled = false; }
  });

  function flash(text) { const m = $("addMsg"); m.className = "ok"; m.textContent = text; if (!$("adminView").classList.contains("hidden")) return; alertSoft(text); }
  function alertSoft(text) { const t = el("div", "toast", text); Object.assign(t.style, { position: "fixed", left: "50%", bottom: "90px", transform: "translateX(-50%)", background: "var(--panel)", border: "1px solid var(--line)", padding: "10px 16px", borderRadius: "12px", zIndex: 20 }); document.body.append(t); setTimeout(() => t.remove(), 2500); }

  // ---- admin view ----
  async function refresh() {
    const list = $("userList"); list.replaceChildren(el("li", "muted", "Loading..."));
    try {
      const { users, count, cap } = await call("list");
      $("adminCount").textContent = count + " of " + cap + " people";
      $("addBtn").disabled = count >= cap;
      list.replaceChildren();
      users.forEach((u) => {
        const li = el("li"), info = el("div", "uinfo"), name = el("strong", null, u.display_name);
        if (u.is_admin) name.append(el("span", "badge", "ADMIN"));
        info.append(name, el("small", null, "@" + u.username + " · added " + fmt(u.created_at) + " · last sign-in " + fmt(u.last_sign_in_at)));
        const btns = el("div", "ubtns");
        const reset = el("button", null, "Reset password"); reset.type = "button"; reset.addEventListener("click", () => openPw(u.username));
        const ren = el("button", null, "Rename"); ren.type = "button"; ren.addEventListener("click", () => rename(u));
        btns.append(reset, ren);
        if (u.id !== FC.me.id) { const rm = el("button", "destructive", "Remove"); rm.type = "button"; rm.addEventListener("click", () => remove(u)); btns.append(rm); }
        li.dataset.username = u.username; li.append(info, btns); list.append(li);
      });
    } catch (err) { list.replaceChildren(el("li", "err", err.message)); }
  }

  let renameUser = null;
  function rename(u) { renameUser = u; $("nameInput").value = u.display_name; $("nameDialog").dataset.mode = "admin"; $("nameDialog").showModal(); }
  $("nameDialog").addEventListener("close", async () => {
    if ($("nameDialog").dataset.mode !== "admin") return;
    $("nameDialog").dataset.mode = "";
    if ($("nameDialog").returnValue !== "ok" || !renameUser) return;
    const v = $("nameInput").value.trim(); if (!v) return;
    try { await call("rename", { username: renameUser.username, display_name: v }); flash("Renamed to " + v + "."); await refresh(); await FC.reloadProfiles(); }
    catch (err) { flash(err.message); $("addMsg").className = "err"; }
  });

  function remove(u) {
    $("confirmText").textContent = "Remove " + u.display_name + " (@" + u.username + ")? Their account and direct messages will be deleted.";
    $("confirmDialog").returnValue = ""; $("confirmDialog").showModal();
    $("confirmDialog").onclose = async () => {
      if ($("confirmDialog").returnValue !== "ok") return;
      try { await call("delete", { username: u.username }); flash("Removed " + u.username + "."); await refresh(); }
      catch (err) { flash(err.message); $("addMsg").className = "err"; }
    };
  }

  $("addForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const m = $("addMsg"); m.className = "err"; m.textContent = "";
    const username = $("newUser").value.trim(), password = $("newPw").value, display_name = $("newName").value.trim();
    if (!/^[A-Za-z0-9._-]{3,20}$/.test(username)) { m.textContent = "Username must be 3 to 20 characters: letters, numbers, dot, dash or underscore."; return; }
    if (password.length < 8) { m.textContent = "Password must be at least 8 characters."; return; }
    $("addBtn").disabled = true;
    try {
      await call("create", { username, password, display_name });
      $("addForm").reset(); $("newPw").type = "password"; $("newPwToggle").textContent = "Show";
      flash("Added " + username + "."); await refresh(); await FC.reloadProfiles();
    } catch (err) { m.className = "err"; m.textContent = err.message; }
    finally { $("addBtn").disabled = false; }
  });

  $("adminBtn").addEventListener("click", () => { if (!FC.isAdmin) return; $("menu").classList.add("hidden"); $("addMsg").textContent = ""; $("adminView").classList.remove("hidden"); refresh(); });
  $("adminBack").addEventListener("click", () => $("adminView").classList.add("hidden"));
})();
