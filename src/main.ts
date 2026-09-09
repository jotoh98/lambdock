import { config, paths } from "./config.ts";
import { installConsoleCapture } from "./console.ts";
import { installCrashGuard } from "./guard.ts";
import { handleAdmin } from "./admin.ts";
import { closeKv, openKv } from "./kv.ts";
import * as registry from "./registry.ts";
import * as store from "./store.ts";
import { invoke } from "./runtime.ts";

const ADMIN = config.adminPrefix; // "/__"

function notFound(body: unknown) {
  return Response.json(body, { status: 404 });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/" || path === ADMIN) {
    return Response.redirect(new URL(`${ADMIN}/`, url), 302);
  }
  if (path.startsWith(`${ADMIN}/`)) {
    return await handleAdmin(req, path.slice(ADMIN.length));
  }
  if (path === "/favicon.ico") return new Response(null, { status: 204 });

  // Every other path belongs to a function: /<slug>/<sub-path>
  const slug = decodeURIComponent(path.slice(1).split("/")[0]);
  let sub = path.slice(1 + slug.length) || "/";
  if (sub.length > 1 && sub.endsWith("/")) sub = sub.slice(0, -1); // "/a/" and "/a" are the same route

  const entry = await registry.get(slug);
  if (!entry) {
    return notFound({
      error: "no_such_function",
      requested: slug,
      available: registry.all().map((e) => `/${e.slug}`),
      editor: `${ADMIN}/`,
    });
  }
  if (!entry.meta.enabled) {
    return Response.json({ error: "function_disabled", function: slug }, { status: 503 });
  }
  if (entry.error || !entry.handler) {
    return Response.json({
      error: "function_failed_to_load",
      function: slug,
      detail: entry.error,
    }, { status: 500 });
  }

  const match = registry.matchRoute(entry, req.method, sub);
  if (!match) {
    return notFound({
      error: "no_matching_route",
      function: slug,
      path: sub,
      method: req.method,
      routes: entry.routes.map((r) => `${r.method} /${slug}${r.path === "/" ? "" : r.path}`),
    });
  }
  return await invoke(match, req, sub);
}

/** Reloads a function when its file changes on disk, for example from an external editor. */
async function watchFunctions() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dirty = new Set<string>();
  const flush = async () => {
    const slugs = [...dirty];
    dirty.clear();
    for (const slug of slugs) {
      if (await store.hasFn(slug)) await registry.load(slug);
      else registry.forget(slug);
    }
  };
  try {
    for await (const event of Deno.watchFs(paths.functions())) {
      for (const p of event.paths) {
        const rel = p.slice(paths.functions().length + 1);
        const slug = rel.split("/")[0];
        if (slug && !slug.endsWith(".tmp")) dirty.add(slug);
      }
      clearTimeout(timer);
      timer = setTimeout(flush, 150);
    }
  } catch (e) {
    console.warn("file watcher stopped:", e instanceof Error ? e.message : e);
  }
}

if (import.meta.main) {
  installCrashGuard();
  installConsoleCapture();
  await store.init();
  const seeded = await store.seedExamples();
  if (seeded.length) console.log(`seeded example functions: ${seeded.join(", ")}`);
  await openKv();
  await registry.loadAll();
  watchFunctions();

  const shutdown = () => {
    closeKv();
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", shutdown);
  if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", shutdown);

  Deno.serve({
    hostname: config.host,
    port: config.port,
    onListen: ({ hostname, port }) => {
      const host = hostname === "0.0.0.0" ? "localhost" : hostname;
      console.log(`lambdock  http://${host}:${port}`);
      console.log(`editor    http://${host}:${port}${ADMIN}/`);
      console.log(`data      ${config.dataDir}`);
      for (const e of registry.all()) {
        for (const r of e.routes) {
          console.log(`  ${r.method.padEnd(6)} /${e.slug}${r.path === "/" ? "" : r.path}`);
        }
      }
    },
  }, handle);
}

export { handle };
