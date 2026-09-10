import { toFileUrl } from "@std/path";
import { config } from "./config.ts";
import * as store from "./store.ts";
import * as logs from "./logs.ts";
import type { FnConfig, Handler, RouteDef } from "../templates/lambdock.ts";

export interface CompiledRoute {
  method: string;
  path: string;
  pattern: URLPattern;
}

/** What a loaded module was read from. */
export type Target = "draft" | "live" | number;

export interface FnEntry {
  slug: string;
  meta: store.FnMeta;
  /** Module cache key: modification time of the file that was imported. */
  version: number;
  /** Version this entry runs. `null` means it is the draft. */
  liveVersion: number | null;
  /** `meta.json` modification time. Tells the live entry when to reload. */
  metaVersion: number;
  /** False when no version is published. Requests are then refused. */
  live: boolean;
  routes: CompiledRoute[];
  handler: Handler | null;
  timeoutMs: number;
  description: string;
  /** Set when the module does not load or does not export a handler. */
  error: string | null;
}

/** Live entries, one per function. */
const entries = new Map<string, FnEntry>();
/** Draft and old-version entries, used by the admin API only. */
const previews = new Map<string, FnEntry>();

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

/** Imports one handler file and reads its exported configuration. */
async function build(
  slug: string,
  meta: store.FnMeta,
  file: string,
  mtime: number,
  liveVersion: number | null,
  live: boolean,
): Promise<FnEntry> {
  const url = toFileUrl(file);
  url.searchParams.set("v", String(mtime));

  const entry: FnEntry = {
    slug,
    meta,
    version: mtime,
    liveVersion,
    metaVersion: await store.metaVersion(slug),
    live,
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
  } catch (e) {
    entry.error = errorText(e);
  }
  return entry;
}

/**
 * Loads or reloads the live entry of one function.
 * With no published version it loads the draft, so the editor still sees the
 * routes, and marks the entry `live: false` so requests are refused.
 */
export async function load(slug: string): Promise<FnEntry> {
  const meta = await store.readMeta(slug);
  const v = meta.liveVersion;
  const file = (await store.filesOf(slug, v ?? undefined)).handler;
  const entry = v === null
    ? await build(slug, meta, file, await store.sourceVersion(slug), null, false)
    : await build(slug, meta, file, await store.versionMtime(slug, v), v, true);

  const what = v === null ? "draft (no version published)" : `v${v}`;
  if (entry.error) logs.system(slug, `load failed for ${what}: ${entry.error.split("\n")[0]}`);
  else logs.system(slug, `loaded ${what} (${entry.routes.length} route(s))`);

  entries.set(slug, entry);
  return entry;
}

/** Returns the live entry, and reloads it when the selection or the file changed. */
export async function get(slug: string): Promise<FnEntry | null> {
  if (!(await store.hasFn(slug))) {
    entries.delete(slug);
    return null;
  }
  const cached = entries.get(slug);
  if (cached) {
    const metaVersion = await store.metaVersion(slug);
    if (metaVersion === cached.metaVersion) {
      // A draft-only entry follows the draft file, so an external edit is picked up.
      if (cached.liveVersion !== null) return cached;
      if ((await store.sourceVersion(slug)) === cached.version) return cached;
    }
  }
  return await load(slug);
}

/**
 * Loads the draft or one published version, for the admin API.
 * These entries never answer a public request.
 */
export async function loadTarget(slug: string, target: Target): Promise<FnEntry> {
  const meta = await store.readMeta(slug);
  if (target === "live") {
    if (meta.liveVersion === null) throw new Deno.errors.NotFound("No version is published.");
    target = meta.liveVersion;
  }
  const isDraft = target === "draft";
  const file = (await store.filesOf(slug, isDraft ? undefined : target as number)).handler;
  const mtime = isDraft
    ? await store.sourceVersion(slug)
    : await store.versionMtime(slug, target as number);

  const key = `${slug}@${target}`;
  const cached = previews.get(key);
  if (cached && cached.version === mtime) return cached;

  const entry = await build(
    slug,
    meta,
    file,
    mtime,
    isDraft ? null : target as number,
    false,
  );
  previews.set(key, entry);
  return entry;
}

export function peek(slug: string): FnEntry | undefined {
  return entries.get(slug);
}

export function all(): FnEntry[] {
  return [...entries.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export function forget(slug: string) {
  entries.delete(slug);
  for (const key of previews.keys()) {
    if (key.startsWith(`${slug}@`)) previews.delete(key);
  }
}

export async function loadAll() {
  entries.clear();
  previews.clear();
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
