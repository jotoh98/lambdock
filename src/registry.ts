import { toFileUrl } from "@std/path";
import { config, paths } from "./config.ts";
import * as store from "./store.ts";
import * as logs from "./logs.ts";
import type { FnConfig, Handler, RouteDef } from "../templates/lambdock.ts";

export interface CompiledRoute {
  method: string;
  path: string;
  pattern: URLPattern;
}

export interface FnEntry {
  slug: string;
  meta: store.FnMeta;
  version: number;
  routes: CompiledRoute[];
  handler: Handler | null;
  timeoutMs: number;
  description: string;
  /** Set when the module does not load or does not export a handler. */
  error: string | null;
}

const entries = new Map<string, FnEntry>();

const DEFAULT_ROUTES: RouteDef[] = [{ method: "*", path: "/*" }];

function compileRoutes(routes: RouteDef[]): CompiledRoute[] {
  const out: CompiledRoute[] = [];
  for (const r of routes) {
    let path = r.path ?? "/*";
    if (!path.startsWith("/")) path = "/" + path;
    out.push({
      method: (r.method ?? "*").toUpperCase(),
      path,
      pattern: new URLPattern({ pathname: path }),
    });
  }
  return out;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}\n${e.stack ?? ""}`.trim();
  return String(e);
}

/** Loads or reloads one function. The module cache key is the file modification time. */
export async function load(slug: string): Promise<FnEntry> {
  const meta = await store.readMeta(slug);
  const version = await store.sourceVersion(slug);
  const url = toFileUrl(paths.handler(slug));
  url.searchParams.set("v", String(version));

  const entry: FnEntry = {
    slug,
    meta,
    version,
    routes: compileRoutes(DEFAULT_ROUTES),
    handler: null,
    timeoutMs: config.defaultTimeoutMs,
    description: "",
    error: null,
  };

  try {
    const mod = await import(url.href);
    const handler = mod.default ?? mod.handler;
    if (typeof handler !== "function") {
      throw new TypeError("The module must have a default export that is a function.");
    }
    const cfg: FnConfig = mod.config ?? {};
    entry.handler = handler as Handler;
    entry.routes = compileRoutes(cfg.routes?.length ? cfg.routes : DEFAULT_ROUTES);
    entry.timeoutMs = cfg.timeoutMs ?? config.defaultTimeoutMs;
    entry.description = cfg.description ?? "";
    logs.system(slug, `loaded (${entry.routes.length} route(s))`);
  } catch (e) {
    entry.error = errorText(e);
    logs.system(slug, `load failed: ${entry.error.split("\n")[0]}`);
  }

  entries.set(slug, entry);
  return entry;
}

/** Returns the entry, and reloads it when the file changed on disk. */
export async function get(slug: string): Promise<FnEntry | null> {
  if (!(await store.hasFn(slug))) {
    entries.delete(slug);
    return null;
  }
  const cached = entries.get(slug);
  if (cached) {
    const version = await store.sourceVersion(slug);
    if (version === cached.version) return cached;
  }
  return await load(slug);
}

export function peek(slug: string): FnEntry | undefined {
  return entries.get(slug);
}

export function all(): FnEntry[] {
  return [...entries.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export function forget(slug: string) {
  entries.delete(slug);
}

export async function loadAll() {
  entries.clear();
  for (const slug of await store.listSlugs()) await load(slug);
}

export interface Match {
  entry: FnEntry;
  route: CompiledRoute;
  params: Record<string, string>;
}

/**
 * Matches a sub-path against the routes of a function.
 * The root path is tried as "/" and as "", because a pattern such as "/:name?"
 * makes the leading separator part of the optional group.
 */
export function matchRoute(entry: FnEntry, method: string, path: string): Match | null {
  const m = method.toUpperCase();
  const candidates = path === "/" ? ["/", ""] : [path];
  for (const route of entry.routes) {
    if (route.method !== "*" && route.method !== m) continue;
    let res: URLPatternResult | null = null;
    for (const c of candidates) {
      res = route.pattern.exec({ pathname: c });
      if (res) break;
    }
    if (!res) continue;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.pathname.groups)) {
      if (v !== undefined) params[k] = decodeURIComponent(v);
    }
    return { entry, route, params };
  }
  return null;
}
