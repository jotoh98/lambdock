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
    dirty: false,
    tab: "routes",
    logs: [],
    test: {}, // per-slug request draft
    lastResponse: null,
    problems: "",
    /** Which draft file the editor shows: "handler" or "tests". */
    file: "handler",
    /** Text of both draft files, and the text the server holds. */
    buffers: { handler: "", tests: "" },
    savedBuffers: { handler: "", tests: "" },
    /** Last `deno test` run of this function. */
    testRun: null,
    versions: null,
  };

  /* ---------------- helpers ---------------- */

  async function api(path, opts) {
    const res = await fetch(API + path, {
      ...opts,
      headers: { "content-type": "application/json", ...opts?.headers },
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
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
  }

  /** Copies the editor text into the buffer of the file that is shown. */
  function stash() {
    if (state.slug) state.buffers[state.file] = getSource();
  }

  /** Switches the editor between handler.ts and handler.test.ts.
   *  `keep` is false when the buffers were just filled from the server: the
   *  editor still holds the previous function, so stashing would clobber them. */
  function showFile(file, keep = true) {
    if (keep) stash();
    state.file = file;
    for (const b of $("fileTabs").querySelectorAll("button")) {
      b.classList.toggle("active", b.dataset.file === file);
    }
    setSource(state.buffers[file]);
    setDirty(isDirty());
  }

  function isDirty() {
    if (!state.slug) return false;
    const now = { ...state.buffers, [state.file]: getSource() };
    return now.handler !== state.savedBuffers.handler ||
      now.tests !== state.savedBuffers.tests;
  }

  function markDirty() {
    if (state.slug) setDirty(isDirty());
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
    $("btnPublish").disabled = !f;
    $("chkEnabled").disabled = !f;
    $("chkEnabled").checked = f ? f.enabled : false;
    const badge = $("probBadge");
    const has = !!(f && (f.error || state.problems));
    badge.hidden = !has;
    badge.textContent = "!";
    renderVersionPill(f);
  }

  /** Says what answers a request right now, and whether the draft is ahead of it. */
  function renderVersionPill(f) {
    const pill = $("verPill");
    pill.hidden = !f;
    if (!f) return;
    if (!f.live) {
      pill.className = "ver none";
      pill.textContent = "no version";
      pill.title = "A save is a draft. Publish to answer requests.";
    } else if (f.draftAhead) {
      pill.className = "ver ahead";
      pill.textContent = `live v${f.liveVersion} · draft ahead`;
      pill.title = "The draft differs from the version that is live.";
    } else {
      pill.className = "ver";
      pill.textContent = `live v${f.liveVersion}`;
      pill.title = "The draft equals the version that is live.";
    }
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
        : '<div class="empty">No log output yet. Send a request from the Try tab.</div>';
      body.scrollTop = body.scrollHeight;
      return;
    }

    if (state.tab === "tests") {
      const r = state.testRun;
      // The editor may hold newer text than the buffer of the file it shows.
      const testsText = state.file === "tests" ? getSource() : state.buffers.tests;
      const head = `<div class="row">
        <button id="tRun" class="primary">Run tests</button>
        <span class="hint">${
        testsText.trim()
          ? "handler.test.ts runs against the saved draft."
          : "This function has no tests. Write them in handler.test.ts."
      }</span>
      </div>`;
      let out = '<div class="empty">Not run yet.</div>';
      if (r?.running) out = '<div class="empty">Running…</div>';
      else if (r?.skipped) out = `<div class="empty">Skipped: ${esc(r.skipped)}</div>`;
      else if (r) {
        out = `<div class="test-verdict ${r.ok ? "ok" : "err"}">${
          r.ok ? `passed (${r.passed})` : `failed (${r.failed})`
        }</div><pre class="out">${esc(r.output || "no output")}</pre>`;
      }
      body.innerHTML = head + out;
      $("tRun").onclick = runTests;
      return;
    }

    if (state.tab === "versions") {
      const v = state.versions;
      if (!v) {
        body.innerHTML = '<div class="empty">Loading…</div>';
        loadVersions();
        return;
      }
      const rows = [...v.versions].reverse();
      body.innerHTML = `<div class="row">
        <button id="vPublish" class="primary">Publish the draft</button>
        <span class="hint">${
        v.draftAhead
          ? "The draft differs from the live version."
          : "The draft equals the live version."
      }</span>
      </div>` + (rows.length
        ? `<div class="versions">${
          rows.map((r) => {
            const live = r.version === v.liveVersion;
            return `<div class="vrow${live ? " live" : ""}">
              <span class="vnum">v${r.version}</span>
              <span class="vtime">${esc(r.createdAt.slice(0, 19).replace("T", " "))}</span>
              <span class="vgate">check:${esc(r.check)} tests:${esc(r.tests)}</span>
              <span class="vnote">${esc(r.note || "")}</span>
              ${
              live
                ? '<span class="vlive">live</span>'
                : `<button data-v="${r.version}" class="vmake">Make live</button>`
            }
            </div>`;
          }).join("")
        }</div>`
        : '<div class="empty">No version yet. Publish the draft to answer requests.</div>');
      $("vPublish").onclick = publish;
      for (const b of body.querySelectorAll(".vmake")) {
        b.onclick = () => makeLive(Number(b.dataset.v));
      }
      return;
    }

    if (state.tab === "try") {
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
    state.testRun = null;
    state.versions = {
      liveVersion: data.liveVersion,
      draftAhead: data.draftAhead,
      versions: data.versionList ?? [],
    };
    const i = state.functions.findIndex((f) => f.slug === slug);
    if (i >= 0) state.functions[i] = { ...state.functions[i], ...data };
    state.buffers = { handler: data.source, tests: data.tests ?? "" };
    state.savedBuffers = { ...state.buffers };
    showFile("handler", false);
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
      stash();
      const data = await api("/functions/" + encodeURIComponent(state.slug), {
        method: "PUT",
        body: JSON.stringify({
          source: state.buffers.handler,
          tests: state.buffers.tests.trim() ? state.buffers.tests : null,
        }),
      });
      state.savedBuffers = { ...state.buffers };
      state.testRun = null;
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
        const note = data.check?.skipped ? " (check skipped)" : "";
        st.textContent = data.live ? `draft saved${note}` : `draft saved${note}, nothing live`;
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

  /** Creates a version from the saved draft. The server gates it first. */
  async function publish() {
    if (!state.slug) return;
    if (state.dirty) {
      const go = await dialog({
        title: "Unsaved changes",
        body: '<p class="hint">Publish uses the saved draft. Save first.</p>',
        actions: [
          { label: "Save and publish", value: true, kind: "primary" },
          { label: "Cancel", value: false },
        ],
      });
      if (!go) return;
      await save();
    }
    const note = await dialog({
      title: `Publish ${state.slug}`,
      body:
        `<p class="hint">The type check and the tests run first. The new version answers requests at once.</p>
         <div class="field"><label>Note (optional)</label>
         <input id="pNote" placeholder="what changed" spellcheck="false"></div>`,
      actions: [
        { label: "Publish", value: () => $("pNote").value, kind: "primary" },
        { label: "Cancel", value: null },
      ],
    });
    if (note === null) return;

    const st = $("status");
    st.textContent = "publishing…";
    st.className = "status";
    try {
      const res = await api(`/functions/${encodeURIComponent(state.slug)}/versions`, {
        method: "POST",
        body: JSON.stringify({ note }),
      });
      state.testRun = res.tests;
      st.textContent = `live on v${res.version.version}`;
      st.className = "status ok";
      toast(`${state.slug} is live on v${res.version.version}`);
      state.tab = "versions";
      await refresh();
      await loadVersions();
    } catch (e) {
      st.textContent = "not published";
      st.className = "status err";
      if (e.status === 422) {
        // The gate refused it. Show what failed instead of a bare message.
        state.testRun = e.body.tests;
        state.problems = e.body.check?.ok === false ? e.body.check.output : "";
        state.tab = e.body.error === "check_failed" ? "problems" : "tests";
        renderPanel();
        const force = await dialog({
          title: "The gate failed",
          body: `<p class="hint">${
            esc(e.body.error === "check_failed" ? "The type check failed." : "The tests failed.")
          } Publish anyway?</p>`,
          actions: [
            { label: "Publish anyway", value: true, kind: "danger" },
            { label: "Cancel", value: false, kind: "primary" },
          ],
        });
        if (!force) return;
        const res = await api(`/functions/${encodeURIComponent(state.slug)}/versions`, {
          method: "POST",
          body: JSON.stringify({ note, force: true }),
        });
        toast(`${state.slug} is live on v${res.version.version}`);
        await refresh();
        await loadVersions();
      } else {
        toast(e.message, true);
      }
    }
  }

  /** Runs `deno test` against the saved draft. */
  async function runTests() {
    if (!state.slug) return;
    state.tab = "tests";
    state.testRun = { running: true };
    renderPanel();
    try {
      state.testRun = await api(`/functions/${encodeURIComponent(state.slug)}/test`, {
        method: "POST",
        headers: { "x-lambdock-target": "draft" },
      });
    } catch (e) {
      state.testRun = { ok: false, output: e.message, passed: 0, failed: 0 };
    }
    renderPanel();
  }

  async function loadVersions() {
    if (!state.slug) return;
    state.versions = await api(`/functions/${encodeURIComponent(state.slug)}/versions`);
    renderPanel();
  }

  async function makeLive(version) {
    await api(`/functions/${encodeURIComponent(state.slug)}/live`, {
      method: "POST",
      body: JSON.stringify({ version }),
    });
    toast(`${state.slug} is live on v${version}`);
    await refresh();
    await loadVersions();
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
  $("btnPublish").onclick = publish;
  $("btnNew").onclick = createFn;
  for (const b of $("fileTabs").querySelectorAll("button")) {
    b.onclick = () => showFile(b.dataset.file);
  }
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
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === "s") {
      e.preventDefault();
      save();
    } else if (key === "enter") {
      e.preventDefault();
      publish();
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
