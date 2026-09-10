/**
 * Public contract for lambdock functions.
 * This file is copied into the data directory at boot. Do not edit it there.
 */

/** One route of a function. Paths are relative to the function mount point. */
export interface RouteDef {
  /** HTTP method, or "*" for all methods. Default: "*". */
  method?: string;
  /**
   * URLPattern pathname. Supports `:param`, `:param?`, `*` and `{}` groups.
   * Examples: "/", "/:id", "/users/:id/posts/:postId?", "/files/*"
   * Default: "/*"
   */
  path?: string;
}

/** Optional configuration. Export it as `config` from your handler module. */
export interface FnConfig {
  /** Routes of this function. Default: one catch-all route. */
  routes?: RouteDef[];
  /** Milliseconds before the request is aborted. Default: 30000. */
  timeoutMs?: number;
  /** Short text shown in the editor. */
  description?: string;
}

/** Key-value store. The data is private to the function and stays after a reboot. */
export interface FnKv {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { expireIn?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list<T = unknown>(prefix?: string): Promise<Array<{ key: string; value: T }>>;
}

/** Second argument of a handler. */
export interface Ctx {
  /** Path parameters of the matched route. */
  params: Record<string, string>;
  /** The parsed request URL. */
  url: URL;
  /** Path after the mount point, for example "/users/42". */
  path: string;
  /** Name of this function. */
  slug: string;
  /** Unique id of this invocation. */
  requestId: string;
  /** Environment variables from the shared env store. */
  env: Record<string, string>;
  /** Persistent key-value store of this function. */
  kv: FnKv;
  /** Writes a log line. `console.log` also goes to the editor log panel. */
  log: (...args: unknown[]) => void;
  /** Aborts when the request is cancelled or the timeout expires. */
  signal: AbortSignal;
}

/**
 * A handler. Return a `Response`, or a plain value:
 *   - `string`            -> text/plain
 *   - `undefined`/`null`  -> 204 No Content
 *   - anything else       -> application/json
 */
export type Handler = (
  req: Request,
  ctx: Ctx,
) => Response | Promise<Response> | unknown;

/** Turns the return value of a handler into a Response. The server uses this too. */
export function toResponse(value: unknown): Response {
  if (value instanceof Response) return value;
  if (value === undefined || value === null) return new Response(null, { status: 204 });
  if (typeof value === "string") {
    return new Response(value, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (value instanceof ReadableStream || value instanceof Uint8Array || value instanceof Blob) {
    return new Response(value as BodyInit);
  }
  return Response.json(value);
}

/* ------------------------------------------------------------------ tests ---- */

/** A `FnKv` that lives in memory. Tests get one, so they never touch stored data. */
export function memoryKv(): FnKv {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string) {
      return Promise.resolve(map.has(key) ? map.get(key) as T : null);
    },
    set(key, value) {
      map.set(key, value);
      return Promise.resolve();
    },
    delete(key) {
      map.delete(key);
      return Promise.resolve();
    },
    list<T>(prefix = "") {
      const out: Array<{ key: string; value: T }> = [];
      for (const [key, value] of map) {
        if (key.startsWith(prefix)) out.push({ key, value: value as T });
      }
      return Promise.resolve(out);
    },
  };
}

/** Builds a context for a test. Every field has a usable default. */
export function testCtx(init: Partial<Ctx> = {}): Ctx {
  const url = init.url ?? new URL("http://localhost/");
  return {
    params: {},
    url,
    path: url.pathname,
    slug: "test",
    requestId: "test",
    env: {},
    kv: memoryKv(),
    log: () => {},
    signal: new AbortController().signal,
    ...init,
  };
}

/**
 * Calls a handler the way the server does and always gives a Response.
 *
 * ```ts
 * import { callFn } from "../../lambdock.ts";
 * import handler from "./handler.ts";
 *
 * Deno.test("the root answers", async () => {
 *   const res = await callFn(handler, "/");
 *   assertEquals(res.status, 200);
 * });
 * ```
 */
export async function callFn(
  handler: Handler,
  request: Request | string,
  ctx: Partial<Ctx> = {},
): Promise<Response> {
  const req = typeof request === "string"
    ? new Request(new URL(request, "http://localhost"))
    : request;
  const url = new URL(req.url);
  return toResponse(await handler(req, testCtx({ ...ctx, url, path: ctx.path ?? url.pathname })));
}
