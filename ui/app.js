"use strict";
// Wrapped in an IIFE: the minified editor bundle is a classic script
// and declares its own top-level names in the global scope.
(function () {
  const BASE = location.pathname.replace(/\/[^/]*$/, "/"); // "/__/"
  const API = BASE + "api";
  const $ = (id) => document.getElementById(id);

  const state = {
    functions: [],
    server: {},
    env: {},
    slug: null,
    saved: "",
    dirty: false,
    tab: "routes",
    logs: [],
    test: {}, // per-slug request draft
    lastResponse: null,
    problems: "",
  };

  /* ---------------- helpers ---------------- */

  async function api(path, opts) {
    const res = await fetch(API + path, {
      headers: { "content-type": "application/json" },
      ...opts,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  let toastTimer;
  function toast(msg, isError) {
    const el = $("toast");
    el.textContent = msg;
    el.className = "show" + (isError ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = ""), 2600);
  }

  function esc(s) {
    return String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]),
    );
  }

  /** Replaces window.prompt / window.confirm. Browser modals block automation. */
  function dialog({ title, body, actions }) {
    return new Promise((resolve) => {
      const dlg = $("dlg");
      $("dlgTitle").textContent = title;
      $("dlgBody").innerHTML = body;
      const foot = $("dlgFoot");
      foot.innerHTML = "";
      for (const a of actions) {
        const b = document.createElement("button");
        b.textContent = a.label;
        if (a.kind) b.className = a.kind;
        b.onclick = () => {
          const v = a.value === undefined
            ? true
            : (typeof a.value === "function" ? a.value() : a.value);
          dlg.close();
          resolve(v);
        };
        foot.appendChild(b);
      }
      dlg.onclose = () => resolve(null);
      dlg.showModal();
      const first = $("dlgBody").querySelector("input, textarea");
      if (first) {
        first.focus();
        first.select?.();
      }
      $("dlgBody").onkeydown = (e) => {
        if (e.key === "Enter" && e.target.tagName === "INPUT") {
          e.preventDefault();
          foot.querySelector("button.primary")?.click();
        }
      };
    });
  }

  /* ---------------- editor ---------------- */

  let editor = null;
  const fallback = $("fallback");

  function initEditor() {
    if (!globalThis.CM) {
      fallback.hidden = false;
      fallback.addEventListener("input", markDirty);
      return;
    }
    editor = new CM.EditorView({
      doc: "",
      extensions: [
        CM.basicSetup,
        CM.javascript({ typescript: true }),
        CM.oneDark,
        CM.keymap.of([CM.indentWithTab]),
        CM.EditorView.updateListener.of((u) => {
          if (u.docChanged) markDirty();
        }),
      ],
      parent: $("editorWrap"),
    });
  }

  function getSource() {
    return editor ? editor.state.doc.toString() : fallback.value;
  }

  function setSource(src) {
    if (editor) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: src } });
    } else {
      fallback.value = src;
    }
    state.saved = src;
    setDirty(false);
  }

  function markDirty() {
    if (state.slug && getSource() !== state.saved) setDirty(true);
  }

  function setDirty(v) {
    state.dirty = v;
    $("btnSave").disabled = !v;
    const st = $("status");
    if (v) {
      st.textContent = "unsaved changes";
      st.className = "status";
    }
  }

  /* ---------------- rendering ---------------- */

  function renderSidebar() {
    const list = $("fnList");
    if (!state.functions.length) {
      list.innerHTML = '<div class="empty">No functions yet.<br>Press + to add one.</div>';
      return;
    }
    list.innerHTML = state.functions.map((f) => {
      const cls = f.error ? "err" : (f.enabled ? "" : "off");
      return `<div class="fn${f.slug === state.slug ? " active" : ""}" data-slug="${esc(f.slug)}">
      <span class="dot ${cls}"></span><span class="name">${esc(f.slug)}</span>
    </div>`;
    }).join("");
    for (const el of list.querySelectorAll(".fn")) {
      el.onclick = () => open(el.dataset.slug);
    }
  }

  function current() {
    return state.functions.find((f) => f.slug === state.slug) || null;
  }

  function renderToolbar() {
    const f = current();
    $("curSlug").textContent = f ? f.slug : "—";
    $("btnRename").disabled = !f;
    $("btnDelete").disabled = !f;
    $("chkEnabled").disabled = !f;
    $("chkEnabled").checked = f ? f.enabled : false;
    const badge = $("probBadge");
    const has = !!(f && (f.error || state.problems));
    badge.hidden = !has;
    badge.textContent = "!";
  }

  function renderPanel() {
    for (const t of document.querySelectorAll(".tab")) {
      t.classList.toggle("active", t.dataset.tab === state.tab);
    }
    const body = $("panelBody");
    const f = current();
    if (!f) {
      body.innerHTML = '<div class="empty">Select a function.</div>';
      return;
    }

    if (state.tab === "routes") {
      body.innerHTML = `
      ${f.description ? `<p class="hint">${esc(f.description)}</p>` : ""}
      <div class="routes">${
        f.routes.map((r) =>
          `<div class="route"><span class="method ${esc(r.method)}" data-m="${esc(r.method)}">${
            esc(r.method)
          }</span>
           <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></div>`
        ).join("")
      }</div>
      <p class="hint" style="margin-top:12px">
        Change routes with <code>export const config</code> in the handler.
        Path patterns use <code>:param</code>, <code>:param?</code> and <code>*</code>.
      </p>`;
      return;
    }

    if (state.tab === "problems") {
      const text = f.error || state.problems;
      body.innerHTML = text
        ? `<pre class="out">${esc(text)}</pre>`
        : '<div class="empty">No problems.</div>';
      return;
    }

    if (state.tab === "logs") {
      const lines = state.logs.filter((l) => l.slug === state.slug);
      body.innerHTML = lines.length
        ? lines.map((l) =>
          `<div class="log-line ${esc(l.level)}"><span class="t">${
            new Date(l.ts).toLocaleTimeString()
          }</span><span class="s">${esc(l.requestId)}</span><span class="m">${
            esc(l.text)
          }</span></div>`
        ).join("")
        : '<div class="empty">No log output yet. Send a request from the Test tab.</div>';
      body.scrollTop = body.scrollHeight;
      return;
    }

    if (state.tab === "test") {
      const t = state.test[f.slug] ||= {
        method: f.routes[0]?.method === "*" ? "GET" : (f.routes[0]?.method || "GET"),
        path: f.routes[0]?.url || `/${f.slug}`,
        body: "",
        headers: "",
      };
      body.innerHTML = `
      <div class="test-grid">
        <div>
          <div class="field">
            <label>Request</label>
            <div class="req-line">
              <select id="tMethod">${
        ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
          .map((m) => `<option${m === t.method ? " selected" : ""}>${m}</option>`).join("")
      }</select>
              <input id="tPath" value="${esc(t.path)}" spellcheck="false">
              <button id="tSend" class="primary">Send</button>
            </div>
          </div>
          <div class="field">
            <label>Headers (one per line: Name: value)</label>
            <textarea id="tHeaders" rows="3" spellcheck="false">${esc(t.headers)}</textarea>
          </div>
          <div class="field">
            <label>Body</label>
            <textarea id="tBody" rows="7" spellcheck="false">${esc(t.body)}</textarea>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;min-height:0">
          <label style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--fg-dim)">Response</label>
          <div id="tResult" style="flex:1;min-height:0;margin-top:4px">
            ${
        state.lastResponse
          ? renderResponse(state.lastResponse)
          : '<div class="empty">No request sent.</div>'
      }
          </div>
        </div>
      </div>`;

      const save = () => {
        t.method = $("tMethod").value;
        t.path = $("tPath").value;
        t.headers = $("tHeaders").value;
        t.body = $("tBody").value;
      };
      for (const id of ["tMethod", "tPath", "tHeaders", "tBody"]) $(id).onchange = save;
      $("tSend").onclick = () => {
        save();
        sendTest(t);
      };
      $("tPath").onkeydown = (e) => {
        if (e.key === "Enter") {
          save();
          sendTest(t);
        }
      };
    }
  }

  function renderResponse(r) {
    const cls = "s" + String(r.status)[0];
    return `<div class="res-head">
      <span class="code ${cls}">${r.status} ${esc(r.statusText)}</span>
      <span style="color:var(--fg-dim)">${r.ms} ms</span>
      <span style="color:var(--fg-dim)">${r.size} B</span>
    </div>
    <pre class="out">${esc(r.body)}</pre>
    <details style="margin-top:8px"><summary style="cursor:pointer;color:var(--fg-dim);font-size:12px">Response headers</summary>
      <pre class="out" style="margin-top:6px">${esc(r.headers)}</pre></details>`;
  }

  async function sendTest(t) {
    const headers = {};
    for (const line of t.headers.split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const hasBody = !["GET", "HEAD"].includes(t.method);
    if (hasBody && t.body.trim() && !headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
    const started = performance.now();
    try {
      const res = await fetch(t.path, {
        method: t.method,
        headers,
        body: hasBody && t.body.trim() ? t.body : undefined,
      });
      const body = await res.text();
      let pretty = body;
      try {
        pretty = JSON.stringify(JSON.parse(body), null, 2);
      } catch { /* keep raw */ }
      state.lastResponse = {
        status: res.status,
        statusText: res.statusText || "",
        ms: Math.round(performance.now() - started),
        size: new Blob([body]).size,
        body: pretty || "(empty)",
        headers: [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n"),
      };
    } catch (e) {
      state.lastResponse = {
        status: 0,
        statusText: "network error",
        ms: Math.round(performance.now() - started),
        size: 0,
        body: String(e),
        headers: "",
      };
    }
    $("tResult").innerHTML = renderResponse(state.lastResponse);
  }

  /* ---------------- actions ---------------- */

  async function refresh() {
    const s = await api("/state");
    state.functions = s.functions;
    state.server = s.server;
    state.env = s.env;
    $("baseUrl").textContent = location.origin;
    renderSidebar();
    renderToolbar();
    renderPanel();
  }

  async function open(slug) {
    if (state.dirty && slug !== state.slug) {
      const go = await dialog({
        title: "Unsaved changes",
        body: `<p class="hint">The function <code>${
          esc(state.slug)
        }</code> has unsaved changes.</p>`,
        actions: [
          { label: "Discard", value: true, kind: "danger" },
          { label: "Stay", value: false, kind: "primary" },
        ],
      });
      if (!go) return;
    }
    const data = await api("/functions/" + encodeURIComponent(slug));
    state.slug = slug;
    state.problems = "";
    const i = state.functions.findIndex((f) => f.slug === slug);
    if (i >= 0) state.functions[i] = { ...state.functions[i], ...data };
    setSource(data.source);
    $("status").textContent = "";
    $("status").className = "status";
    renderSidebar();
    renderToolbar();
    renderPanel();
  }

  async function save() {
    if (!state.slug) return;
    const st = $("status");
    st.textContent = "saving…";
    st.className = "status";
    try {
      const data = await api("/functions/" + encodeURIComponent(state.slug), {
        method: "PUT",
        body: JSON.stringify({ source: getSource() }),
      });
      state.saved = getSource();
      setDirty(false);
      state.problems = data.check?.ok === false ? data.check.output : "";
      const i = state.functions.findIndex((f) => f.slug === state.slug);
      if (i >= 0) state.functions[i] = { ...state.functions[i], ...data };
      if (data.error) {
        st.textContent = "load failed";
        st.className = "status err";
        state.tab = "problems";
      } else if (state.problems) {
        st.textContent = "type errors";
        st.className = "status err";
        state.tab = "problems";
      } else {
        st.textContent = data.check?.skipped ? "saved (check skipped)" : "saved";
        st.className = "status ok";
      }
      renderSidebar();
      renderToolbar();
      renderPanel();
    } catch (e) {
      st.textContent = "save failed";
      st.className = "status err";
      toast(e.message, true);
    }
  }

  async function createFn() {
    const slug = await dialog({
      title: "New function",
      body:
        `<p class="hint">Lowercase letters, digits and "-". It becomes the first path segment.</p>
      <input id="newSlug" placeholder="my-function" style="width:100%" spellcheck="false">`,
      actions: [
        { label: "Cancel", value: null },
        { label: "Create", kind: "primary", value: () => $("newSlug").value.trim() },
      ],
    });
    if (!slug) return;
    try {
      await api("/functions", { method: "POST", body: JSON.stringify({ slug }) });
      await refresh();
      await open(slug);
      toast(`created /${slug}`);
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function renameFn() {
    const from = state.slug;
    if (!from) return;
    const to = await dialog({
      title: "Rename function",
      body: `<input id="newName" value="${esc(from)}" style="width:100%" spellcheck="false">`,
      actions: [
        { label: "Cancel", value: null },
        { label: "Rename", kind: "primary", value: () => $("newName").value.trim() },
      ],
    });
    if (!to || to === from) return;
    try {
      await api(`/functions/${encodeURIComponent(from)}/rename`, {
        method: "POST",
        body: JSON.stringify({ to }),
      });
      state.slug = to;
      await refresh();
      await open(to);
      toast(`renamed to /${to}`);
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function deleteFn() {
    const slug = state.slug;
    if (!slug) return;
    const ok = await dialog({
      title: "Delete function",
      body: `<p class="hint">Delete <code>${
        esc(slug)
      }</code> with its source and its stored data. This cannot be undone.</p>`,
      actions: [
        { label: "Cancel", value: null },
        { label: "Delete", kind: "danger", value: true },
      ],
    });
    if (!ok) return;
    await api("/functions/" + encodeURIComponent(slug), { method: "DELETE" });
    state.slug = null;
    state.dirty = false;
    setSource("");
    await refresh();
    toast(`deleted ${slug}`);
  }

  async function editEnv() {
    const rows = (env) =>
      Object.entries(env).map(([k, v]) =>
        `<div class="env-row"><input class="ek" value="${
          esc(k)
        }" placeholder="NAME"><input class="ev" value="${
          esc(v)
        }" placeholder="value"><button class="rm">&times;</button></div>`
      ).join("");
    const result = await dialog({
      title: "Environment variables",
      body:
        `<p class="hint">Available to every function as <code>ctx.env</code>. Stored in <code>data/env.json</code>.</p>
      <div id="envRows">${rows(state.env)}</div>
      <button id="envAdd" style="margin-top:6px">+ Add</button>`,
      actions: [
        { label: "Cancel", value: null },
        {
          label: "Save",
          kind: "primary",
          value: () => {
            const out = {};
            for (const row of document.querySelectorAll("#envRows .env-row")) {
              const k = row.querySelector(".ek").value.trim();
              if (k) out[k] = row.querySelector(".ev").value;
            }
            return out;
          },
        },
      ],
    });
    if (!result) return;
    try {
      state.env = await api("/env", { method: "PUT", body: JSON.stringify(result) });
      toast("environment saved");
    } catch (e) {
      toast(e.message, true);
    }
  }

  function bindEnvDialog() {
    $("dlgBody").addEventListener("click", (e) => {
      if (e.target.classList.contains("rm")) e.target.closest(".env-row").remove();
      if (e.target.id === "envAdd") {
        const div = document.createElement("div");
        div.className = "env-row";
        div.innerHTML =
          '<input class="ek" placeholder="NAME"><input class="ev" placeholder="value"><button class="rm">&times;</button>';
        $("envRows").appendChild(div);
        div.querySelector(".ek").focus();
      }
    });
  }

  function showHelp() {
    dialog({
      title: "How lambdock works",
      body:
        `<p class="hint">Every function is mounted below its own first path segment, so routes cannot collide.</p>
<pre class="out">import type { Ctx, FnConfig } from "../../lambdock.ts";

export const config: FnConfig = {
  routes: [
    { method: "GET",  path: "/" },
    { method: "GET",  path: "/:id" },
    { method: "POST", path: "/:id/items/*" },
  ],
  timeoutMs: 30000,
};

export default async function handler(req: Request, ctx: Ctx) {
  ctx.params.id        // path parameters
  ctx.url              // full URL
  ctx.env.MY_KEY       // shared env store
  await ctx.kv.set("k", { a: 1 });   // persistent storage
  return { ok: true }; // plain values become JSON
}</pre>
<p class="hint" style="margin-top:10px">Return a <code>Response</code> for full control. A string becomes text,
<code>null</code> becomes 204, anything else becomes JSON. <code>console.log</code> appears in the Logs tab.</p>`,
      actions: [{ label: "Close", kind: "primary", value: true }],
    });
  }

  /* ---------------- logs stream ---------------- */

  function connectLogs() {
    const es = new EventSource(API + "/logs/stream");
    es.onmessage = (e) => {
      const line = JSON.parse(e.data);
      state.logs.push(line);
      if (state.logs.length > 2000) state.logs.splice(0, state.logs.length - 2000);
      if (state.tab === "logs" && line.slug === state.slug) renderPanel();
    };
    es.onerror = () => {/* EventSource reconnects on its own */};
  }

  /* ---------------- panel resize ---------------- */

  function bindSplitter() {
    const pane = $("pane");
    let startY = 0, startH = 240;
    const onMove = (e) => {
      const h = Math.min(Math.max(startH - (e.clientY - startY), 90), globalThis.innerHeight - 220);
      pane.style.setProperty("--panel-h", h + "px");
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      localStorage.setItem("panelH", pane.style.getPropertyValue("--panel-h"));
    };
    $("splitter").onmousedown = (e) => {
      startY = e.clientY;
      startH = parseInt(getComputedStyle(pane).getPropertyValue("--panel-h")) || 240;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };
    const stored = localStorage.getItem("panelH");
    if (stored) pane.style.setProperty("--panel-h", stored);
  }

  /* ---------------- boot ---------------- */

  initEditor();
  bindSplitter();
  bindEnvDialog();

  $("btnSave").onclick = save;
  $("btnNew").onclick = createFn;
  $("btnRename").onclick = renameFn;
  $("btnDelete").onclick = deleteFn;
  $("btnEnv").onclick = editEnv;
  $("btnHelp").onclick = showHelp;
  $("btnClearLogs").onclick = async () => {
    if (!state.slug) return;
    await api(`/functions/${encodeURIComponent(state.slug)}/logs`, { method: "DELETE" });
    state.logs = state.logs.filter((l) => l.slug !== state.slug);
    renderPanel();
  };
  $("chkEnabled").onchange = async (e) => {
    await api(`/functions/${encodeURIComponent(state.slug)}/enabled`, {
      method: "POST",
      body: JSON.stringify({ enabled: e.target.checked }),
    });
    await refresh();
  };

  for (const t of document.querySelectorAll(".tab")) {
    t.onclick = () => {
      state.tab = t.dataset.tab;
      renderPanel();
    };
  }

  globalThis.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  });

  globalThis.addEventListener("beforeunload", (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  connectLogs();
  refresh().then(() => {
    if (state.functions.length) open(state.functions[0].slug);
  }).catch((e) => toast(e.message, true));
})();
