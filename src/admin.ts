import { contentType } from "@std/media-types";
import { extname } from "@std/path";
import { config } from "./config.ts";
import * as store from "./store.ts";
import * as registry from "./registry.ts";
import * as logs from "./logs.ts";
import { dropNamespace } from "./kv.ts";
import { checkFunction, checkVersion } from "./typecheck.ts";
import { runTests, runVersionTests } from "./tests.ts";
import { invoke } from "./runtime.ts";
import type { GateResult } from "./store.ts";

const UI_ROOT = new URL("../ui/", import.meta.url);

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function dto(entry: registry.FnEntry) {
  return {
    slug: entry.slug,
    enabled: entry.meta.enabled,
    description: entry.description,
    updatedAt: entry.meta.updatedAt,
    error: entry.error,
    /** The version that answers requests, or null for a function with a draft only. */
    liveVersion: entry.meta.liveVersion,
    live: entry.live,
    versions: entry.meta.versions.length,
    routes: entry.routes.map((r) => ({
      method: r.method,
      path: r.path,
      url: `/${entry.slug}${r.path === "/" ? "" : r.path}`,
    })),
  };
}

/** The same fields plus filesystem reads: the draft language, and whether it differs from live. */
async function fullDto(entry: registry.FnEntry) {
  return {
    ...dto(entry),
    lang: (await store.filesOf(entry.slug)).lang,
    draftAhead: await store.draftIsAhead(entry.slug),
  };
}

const LANG_ERROR = `lang must be "ts" or "tsx"`;

async function reloadAndDescribe(slug: string) {
  const entry = await registry.load(slug);
  const check = await checkFunction(slug);
  return { ...await fullDto(entry), check };
}

/** Reads `target` from the request. Default: the draft. */
function targetOf(req: Request, url = new URL(req.url)): registry.Target {
  const raw = req.headers.get("x-lambdock-target") ?? url.searchParams.get("__target") ?? "draft";
  if (raw === "draft" || raw === "live") return raw;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new TypeError(`Bad target: ${raw}`);
  return n;
}

function label(target: registry.Target): string {
  return target === "draft" ? "[draft]" : target === "live" ? "[live]" : `[v${target}]`;
}

/** Sends the log stream to the editor with server-sent events. */
function logStream(): Response {
  let unsubscribe = () => {};
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (line: logs.LogLine) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(line)}\n\n`));
      };
      for (const line of logs.recent()) send(line);
      unsubscribe = logs.subscribe(send);
      const ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          clearInterval(ping);
        }
      }, 25_000);
      const stop = unsubscribe;
      unsubscribe = () => {
        clearInterval(ping);
        stop();
      };
    },
    cancel() {
      unsubscribe();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}

async function serveStatic(path: string): Promise<Response> {
  const rel = path === "" || path === "/" ? "index.html" : path.replace(/^\/+/, "");
  if (rel.includes("..")) return fail("not found", 404);
  const url = new URL(rel, UI_ROOT);
  if (!url.href.startsWith(UI_ROOT.href)) return fail("not found", 404);
  try {
    const file = await Deno.readFile(url);
    return new Response(file, {
      headers: {
        "content-type": contentType(extname(rel)) ?? "application/octet-stream",
        "cache-control": "no-cache",
      },
    });
  } catch {
    return fail("not found", 404);
  }
}

const api: Array<
  {
    method: string;
    pattern: URLPattern;
    run: (m: URLPatternResult, req: Request) => Promise<Response> | Response;
  }
> = [];
const route = (
  method: string,
  path: string,
  run: (m: URLPatternResult, req: Request) => Promise<Response> | Response,
) => api.push({ method, pattern: new URLPattern({ pathname: path }), run });

const slugOf = (m: URLPatternResult) => m.pathname.groups.slug!;

async function need(slug: string): Promise<Response | null> {
  return (await store.hasFn(slug)) ? null : fail("not found", 404);
}

route("GET", "/health", () => json({ ok: true, functions: registry.all().length }));

route("GET", "/state", async () => {
  return json({
    functions: await Promise.all(registry.all().map(fullDto)),
    env: await store.readEnv(),
    server: {
      adminPrefix: config.adminPrefix,
      typeCheck: config.typeCheck,
      runTests: config.runTests,
      defaultTimeoutMs: config.defaultTimeoutMs,
      dataDir: config.dataDir,
    },
  });
});

route("POST", "/functions", async (_m, req) => {
  const body = await req.json() as {
    slug?: string;
    source?: string;
    tests?: string;
    publish?: boolean;
    lang?: string;
  };
  if (!body.slug) return fail("slug is required");
  const invalid = store.validateSlug(body.slug);
  if (invalid) return fail(invalid);
  const lang = body.lang ?? "ts";
  if (!store.isLang(lang)) return fail(LANG_ERROR);
  if (await store.hasFn(body.slug)) return fail(`Function "${body.slug}" already exists.`, 409);
  await store.createFn(body.slug, body.source ?? await store.newFunctionTemplate(lang), {
    tests: body.tests ?? (body.source ? undefined : await store.newTestTemplate(lang)),
    publish: body.publish,
    lang,
  });
  return json(await reloadAndDescribe(body.slug), 201);
});

route("GET", "/functions/:slug", async (m) => {
  const slug = slugOf(m);
  const missing = await need(slug);
  if (missing) return missing;
  const entry = await registry.get(slug);
  const meta = await store.readMeta(slug);
  return json({
    ...await fullDto(entry!),
    source: await store.readSource(slug),
    tests: await store.readTests(slug),
    versionList: meta.versions,
  });
});

/** A save writes the draft. The live route does not change. */
route("PUT", "/functions/:slug", async (m, req) => {
  const slug = slugOf(m);
  const missing = await need(slug);
  if (missing) return missing;
  const body = await req.json() as { source?: string; tests?: string | null; lang?: string };
  if (typeof body.source !== "string" && body.tests === undefined && body.lang === undefined) {
    return fail("source, tests or lang is required");
  }
  // The language goes first, so the source and the tests land in the renamed files.
  if (body.lang !== undefined) {
    if (!store.isLang(body.lang)) return fail(LANG_ERROR);
    await store.setLang(slug, body.lang);
  }
  if (typeof body.source === "string") await store.writeSource(slug, body.source);
  if (body.tests !== undefined) await store.writeTests(slug, body.tests);
  return json(await reloadAndDescribe(slug));
});

route("DELETE", "/functions/:slug", async (m) => {
  const slug = slugOf(m);
  const missing = await need(slug);
  if (missing) return missing;
  await store.deleteFn(slug);
  await dropNamespace(slug);
  registry.forget(slug);
  logs.clear(slug);
  return json({ ok: true });
});

route("POST", "/functions/:slug/rename", async (m, req) => {
  const from = slugOf(m);
  const { to } = await req.json() as { to?: string };
  if (!to) return fail("to is required");
  const invalid = store.validateSlug(to);
  if (invalid) return fail(invalid);
  const missing = await need(from);
  if (missing) return missing;
  if (await store.hasFn(to)) return fail(`Function "${to}" already exists.`, 409);
  await store.renameFn(from, to);
  registry.forget(from);
  logs.clear(from);
  return json(await reloadAndDescribe(to));
});

route("POST", "/functions/:slug/enabled", async (m, req) => {
  const slug = slugOf(m);
  const missing = await need(slug);
  if (missing) return missing;
  const { enabled } = await req.json() as { enabled?: boolean };
  await store.setEnabled(slug, enabled !== false);
  return json(await reloadAndDescribe(slug));
});

/* ------------------------------------------------------------ gate ---- */

route("POST", "/functions/:slug/check", async (m, req) => {
  const slug = slugOf(m);
  const missing = await need(slug);
  if (missing) return missing;
  const target = targetOf(req);
  return json(
    target === "draft"
      ? await checkFunction(slug)
      : await checkVersion(slug, versionOf(target, await store.readMeta(slug))),
  );
});

route("POST", "/functions/:slug/test", async (m, req) => {
  const slug = slugOf(m);
  const missing = await need(slug);
  if (missing) return missing;
  const target = targetOf(req);
  const meta = await store.readMeta(slug);
  const result = target === "draft"
    ? await runTests(slug)
    : await runVersionTests(slug, versionOf(target, meta));
  return json({ target, ...result });
});

/* -------------------------------------------------------- versions ---- */

route("GET", "/functions/:slug/versions", async (m) => {
  const slug = slugOf(m);
  const missing = await need(slug);
  if (missing) return missing;
  const meta = await store.readMeta(slug);
  return json({
    liveVersion: meta.liveVersion,
    draftAhead: await store.draftIsAhead(slug),
    versions: meta.versions,
  });
});

/**
 * Creates a version from the current draft and makes it live.
 * The type check and the tests run first. `force` publishes in spite of them.
 */
route("POST", "/functions/:slug/versions", async (m, req) => {
  const slug = slugOf(m);
  const missing = await need(slug);
  if (missing) return missing;
  const body = await req.json().catch(() => ({})) as { note?: string; force?: boolean };

  const check = await checkFunction(slug);
  const tests = await runTests(slug);
  if (!body.force && !check.ok) return json({ error: "check_failed", check, tests }, 422);
  if (!body.force && !tests.ok) return json({ error: "tests_failed", check, tests }, 422);

  const gate = (ok: boolean, skipped: string | undefined, none = false): GateResult =>
    !ok ? "forced" : none ? "none" : skipped ? "skipped" : "passed";

  const version = await store.createVersion(slug, {
    note: body.note,
    check: gate(check.ok, check.skipped),
    tests: gate(tests.ok, tests.skipped, tests.skipped === "no test file"),
  });
  const entry = await registry.load(slug);
  return json({ ...await fullDto(entry), version, check, tests }, 201);
});

route("GET", "/functions/:slug/versions/:version", async (m) => {
  const slug = slugOf(m);
  const missing = await need(slug);
  if (missing) return missing;
  const n = Number(m.pathname.groups.version);
  const meta = await store.readMeta(slug);
  const found = meta.versions.find((v) => v.version === n);
  if (!found) return fail(`Version ${n} does not exist.`, 404);
  // `version` stays nested: VersionMeta.tests is a gate result, and `tests`
  // at the top level is the test source.
  return json({
    version: found,
    live: meta.liveVersion === n,
    lang: (await store.filesOf(slug, n)).lang,
    source: await store.readVersionSource(slug, n),
    tests: await store.readVersionTests(slug, n),
  });
});

/** Points the live route at a version that already exists. */
route("POST", "/functions/:slug/live", async (m, req) => {
  const slug = slugOf(m);
  const missing = await need(slug);
  if (missing) return missing;
  const { version } = await req.json() as { version?: number };
  if (typeof version !== "number") return fail("version is required");
  try {
    await store.setLiveVersion(slug, version);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 404);
  }
  return json(await reloadAndDescribe(slug));
});

/* ---------------------------------------------------------- invoke ---- */

/**
 * Runs a function without publishing it. The method, headers and body are
 * taken from this request, and the path after `/invoke` is the function path.
 * `x-lambdock-target: draft | live | <n>` chooses what runs. Default: the draft.
 */
async function runTarget(m: URLPatternResult, req: Request): Promise<Response> {
  const slug = slugOf(m);
  const missing = await need(slug);
  if (missing) return missing;

  const url = new URL(req.url);
  let target: registry.Target;
  try {
    target = targetOf(req, url);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  let entry: registry.FnEntry;
  try {
    entry = await registry.loadTarget(slug, target);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 404);
  }
  if (entry.error) {
    return json({ error: "function_failed_to_load", function: slug, detail: entry.error }, 500);
  }

  const rest = m.pathname.groups["0"] ?? "";
  const path = "/" + rest.replace(/^\/+/, "");
  const match = registry.matchRoute(entry, req.method, path);
  if (!match) {
    return json({
      error: "no_matching_route",
      function: slug,
      path,
      method: req.method,
      routes: entry.routes.map((r) => `${r.method} ${r.path}`),
    }, 404);
  }

  // Give the handler a URL that looks like the public one.
  const inner = new URL(`/${slug}${path === "/" ? "" : path}`, url.origin);
  for (const [k, v] of url.searchParams) if (k !== "__target") inner.searchParams.append(k, v);
  const res = await invoke(
    match,
    new Request(inner, { method: req.method, headers: req.headers, body: req.body }),
    path,
    label(target),
  );
  const headers = new Headers(res.headers);
  headers.set("x-lambdock-target", String(target));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

route("*", "/functions/:slug/invoke", runTarget);
route("*", "/functions/:slug/invoke/*", runTarget);

/* ------------------------------------------------------------ logs ---- */

route("GET", "/functions/:slug/logs", (m) => json(logs.recent(slugOf(m))));

route("DELETE", "/functions/:slug/logs", (m) => {
  logs.clear(slugOf(m));
  return json({ ok: true });
});

route("GET", "/logs/stream", () => logStream());

route("GET", "/env", async () => json(await store.readEnv()));

route("PUT", "/env", async (_m, req) => {
  const body = await req.json() as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return fail(`Invalid variable name: ${k}`);
    out[k] = String(v);
  }
  await store.writeEnv(out);
  return json(out);
});

/** Resolves "live" to a number. Throws when nothing is published. */
function versionOf(target: registry.Target, meta: store.FnMeta): number {
  if (typeof target === "number") return target;
  if (meta.liveVersion === null) throw new Deno.errors.NotFound("No version is published.");
  return meta.liveVersion;
}

/** Handles every request below the admin prefix. */
export async function handleAdmin(req: Request, path: string): Promise<Response> {
  if (path.startsWith("/api")) {
    const apiPath = path.slice("/api".length) || "/";
    for (const r of api) {
      if (r.method !== "*" && r.method !== req.method) continue;
      const m = r.pattern.exec({ pathname: apiPath });
      if (!m) continue;
      try {
        return await r.run(m, req);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e), 500);
      }
    }
    return fail("not found", 404);
  }
  return await serveStatic(path);
}
