import { contentType } from "@std/media-types";
import { extname } from "@std/path";
import { config } from "./config.ts";
import * as store from "./store.ts";
import * as registry from "./registry.ts";
import * as logs from "./logs.ts";
import { dropNamespace } from "./kv.ts";
import { checkFunction } from "./typecheck.ts";

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
    routes: entry.routes.map((r) => ({
      method: r.method,
      path: r.path,
      url: `/${entry.slug}${r.path === "/" ? "" : r.path}`,
    })),
  };
}

async function reloadAndDescribe(slug: string) {
  const entry = await registry.load(slug);
  const check = await checkFunction(slug);
  return { ...dto(entry), check };
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

route("GET", "/health", () => json({ ok: true, functions: registry.all().length }));

route("GET", "/state", async () => {
  return json({
    functions: registry.all().map(dto),
    env: await store.readEnv(),
    server: {
      adminPrefix: config.adminPrefix,
      typeCheck: config.typeCheck,
      defaultTimeoutMs: config.defaultTimeoutMs,
      dataDir: config.dataDir,
    },
  });
});

route("POST", "/functions", async (_m, req) => {
  const { slug } = await req.json() as { slug?: string };
  if (!slug) return fail("slug is required");
  const invalid = store.validateSlug(slug);
  if (invalid) return fail(invalid);
  if (await store.hasFn(slug)) return fail(`Function "${slug}" already exists.`, 409);
  await store.createFn(slug, await store.newFunctionTemplate());
  return json(await reloadAndDescribe(slug), 201);
});

route("GET", "/functions/:slug", async (m) => {
  const slug = m.pathname.groups.slug!;
  if (!(await store.hasFn(slug))) return fail("not found", 404);
  const entry = await registry.get(slug);
  return json({ ...dto(entry!), source: await store.readSource(slug) });
});

route("PUT", "/functions/:slug", async (m, req) => {
  const slug = m.pathname.groups.slug!;
  if (!(await store.hasFn(slug))) return fail("not found", 404);
  const { source } = await req.json() as { source?: string };
  if (typeof source !== "string") return fail("source is required");
  await store.writeSource(slug, source);
  return json(await reloadAndDescribe(slug));
});

route("DELETE", "/functions/:slug", async (m) => {
  const slug = m.pathname.groups.slug!;
  if (!(await store.hasFn(slug))) return fail("not found", 404);
  await store.deleteFn(slug);
  await dropNamespace(slug);
  registry.forget(slug);
  logs.clear(slug);
  return json({ ok: true });
});

route("POST", "/functions/:slug/rename", async (m, req) => {
  const from = m.pathname.groups.slug!;
  const { to } = await req.json() as { to?: string };
  if (!to) return fail("to is required");
  const invalid = store.validateSlug(to);
  if (invalid) return fail(invalid);
  if (!(await store.hasFn(from))) return fail("not found", 404);
  if (await store.hasFn(to)) return fail(`Function "${to}" already exists.`, 409);
  await store.renameFn(from, to);
  registry.forget(from);
  logs.clear(from);
  return json(await reloadAndDescribe(to));
});

route("POST", "/functions/:slug/enabled", async (m, req) => {
  const slug = m.pathname.groups.slug!;
  if (!(await store.hasFn(slug))) return fail("not found", 404);
  const { enabled } = await req.json() as { enabled?: boolean };
  await store.setEnabled(slug, enabled !== false);
  return json(await reloadAndDescribe(slug));
});

route("POST", "/functions/:slug/check", async (m) => {
  const slug = m.pathname.groups.slug!;
  if (!(await store.hasFn(slug))) return fail("not found", 404);
  return json(await checkFunction(slug));
});

route("GET", "/functions/:slug/logs", (m) => json(logs.recent(m.pathname.groups.slug!)));

route("DELETE", "/functions/:slug/logs", (m) => {
  logs.clear(m.pathname.groups.slug!);
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

/** Handles every request below the admin prefix. */
export async function handleAdmin(req: Request, path: string): Promise<Response> {
  if (path.startsWith("/api")) {
    const apiPath = path.slice("/api".length) || "/";
    for (const r of api) {
      if (r.method !== req.method) continue;
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
