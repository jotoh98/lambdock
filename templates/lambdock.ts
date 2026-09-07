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
