/**
 * Client for a lambdock server.
 *
 * ```ts
 * const db = new Lambdock({ url: "http://192.168.2.93:8000" });
 * await db.save("db", { source: await Deno.readTextFile("handler.ts") });
 * const run = await db.test("db");
 * if (run.ok) await db.publish("db", { note: "transitous" });
 * ```
 */

/** What a call may run: the draft, the live version, or one version number. */
export type Target = "draft" | "live" | number;

/** The language of a function: `handler.ts` or `handler.tsx`. */
export type Lang = "ts" | "tsx";

export interface RouteInfo {
  method: string;
  path: string;
  url: string;
}

export interface FnSummary {
  slug: string;
  enabled: boolean;
  description: string;
  updatedAt: string;
  error: string | null;
  /** Version that answers requests, or null for a function with a draft only. */
  liveVersion: number | null;
  live: boolean;
  /** Number of versions that exist. */
  versions: number;
  /** True when the draft differs from the live version. */
  draftAhead: boolean;
  /** The language of the draft. */
  lang: Lang;
  routes: RouteInfo[];
}

export type GateResult = "passed" | "none" | "skipped" | "forced";

export interface VersionMeta {
  version: number;
  createdAt: string;
  note: string;
  hash: string;
  check: GateResult;
  tests: GateResult;
}

export interface FnDetail extends FnSummary {
  /** The draft source. */
  source: string;
  /** The draft tests, or null when the function has none. */
  tests: string | null;
  versionList: VersionMeta[];
}

export interface CheckResult {
  ok: boolean;
  output: string;
  skipped?: string;
}

export interface TestResult {
  ok: boolean;
  output: string;
  passed: number;
  failed: number;
  skipped?: string;
  target?: Target;
}

export interface PublishResult extends FnSummary {
  version: VersionMeta;
  check: CheckResult;
  tests: TestResult;
}

export interface VersionList {
  liveVersion: number | null;
  draftAhead: boolean;
  versions: VersionMeta[];
}

export interface VersionDetail {
  version: VersionMeta;
  live: boolean;
  lang: Lang;
  /** The handler source of that version. */
  source: string;
  /** The test source of that version, or null. */
  tests: string | null;
}

export interface LogLine {
  ts: number;
  slug: string;
  requestId: string;
  level: string;
  text: string;
}

export interface ServerState {
  functions: FnSummary[];
  env: Record<string, string>;
  server: {
    adminPrefix: string;
    typeCheck: boolean;
    runTests: boolean;
    defaultTimeoutMs: number;
    dataDir: string;
  };
}

export interface LambdockOptions {
  /** Base URL of the server. Default: `LAMBDOCK_URL` or http://localhost:8000. */
  url?: string;
  /** Replaces `globalThis.fetch`. Used by the tests. */
  fetch?: typeof fetch;
}

/** A response from the server that was not a success. */
export class LambdockError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "LambdockError";
  }
}

const DEFAULT_URL = "http://localhost:8000";

function messageOf(body: unknown, status: number): string {
  if (typeof body === "string" && body) return body;
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    const parts = [o.error, o.message, o.detail, o.hint].filter((x) => typeof x === "string");
    if (parts.length) return parts.join(" - ");
  }
  return `HTTP ${status}`;
}

export class Lambdock {
  readonly url: string;
  #fetch: typeof fetch;

  constructor(opts: LambdockOptions = {}) {
    const raw = opts.url ?? Deno.env.get("LAMBDOCK_URL") ?? DEFAULT_URL;
    this.url = raw.replace(/\/+$/, "");
    this.#fetch = opts.fetch ?? globalThis.fetch;
  }

  /** Sends a request to the admin API and returns the raw response. */
  async raw(path: string, init: RequestInit = {}): Promise<Response> {
    return await this.#fetch(`${this.url}/__/api${path}`, init);
  }

  async #json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.raw(path, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch { /* keep the text */ }
    if (!res.ok) throw new LambdockError(res.status, messageOf(body, res.status), body);
    return body as T;
  }

  #post<T>(path: string, body?: unknown, headers?: HeadersInit): Promise<T> {
    return this.#json<T>(path, {
      method: "POST",
      body: body === undefined ? "{}" : JSON.stringify(body),
      headers,
    });
  }

  /* ------------------------------------------------------------ reading ---- */

  health(): Promise<{ ok: boolean; functions: number }> {
    return this.#json("/health");
  }

  state(): Promise<ServerState> {
    return this.#json("/state");
  }

  async list(): Promise<FnSummary[]> {
    return (await this.state()).functions;
  }

  get(slug: string): Promise<FnDetail> {
    return this.#json(`/functions/${encodeURIComponent(slug)}`);
  }

  versions(slug: string): Promise<VersionList> {
    return this.#json(`/functions/${encodeURIComponent(slug)}/versions`);
  }

  version(slug: string, version: number): Promise<VersionDetail> {
    return this.#json(`/functions/${encodeURIComponent(slug)}/versions/${version}`);
  }

  logs(slug: string): Promise<LogLine[]> {
    return this.#json(`/functions/${encodeURIComponent(slug)}/logs`);
  }

  env(): Promise<Record<string, string>> {
    return this.#json("/env");
  }

  /* ------------------------------------------------------------ writing ---- */

  /** Creates a function. Version 1 goes live at once. */
  create(
    slug: string,
    opts: { source?: string; tests?: string; publish?: boolean; lang?: Lang } = {},
  ): Promise<FnSummary & { check: CheckResult }> {
    return this.#post("/functions", { slug, ...opts });
  }

  /** Saves the draft. The live route does not change. A new `lang` renames the draft files. */
  save(
    slug: string,
    body: { source?: string; tests?: string | null; lang?: Lang },
  ): Promise<FnSummary & { check: CheckResult }> {
    return this.#json(`/functions/${encodeURIComponent(slug)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  remove(slug: string): Promise<{ ok: true }> {
    return this.#json(`/functions/${encodeURIComponent(slug)}`, { method: "DELETE" });
  }

  rename(slug: string, to: string): Promise<FnSummary> {
    return this.#post(`/functions/${encodeURIComponent(slug)}/rename`, { to });
  }

  setEnabled(slug: string, enabled: boolean): Promise<FnSummary> {
    return this.#post(`/functions/${encodeURIComponent(slug)}/enabled`, { enabled });
  }

  setEnv(env: Record<string, string>): Promise<Record<string, string>> {
    return this.#json("/env", { method: "PUT", body: JSON.stringify(env) });
  }

  clearLogs(slug: string): Promise<{ ok: true }> {
    return this.#json(`/functions/${encodeURIComponent(slug)}/logs`, { method: "DELETE" });
  }

  /* --------------------------------------------------------------- gate ---- */

  check(slug: string, target: Target = "draft"): Promise<CheckResult> {
    return this.#post(
      `/functions/${encodeURIComponent(slug)}/check`,
      undefined,
      { "x-lambdock-target": String(target) },
    );
  }

  test(slug: string, target: Target = "draft"): Promise<TestResult> {
    return this.#post(
      `/functions/${encodeURIComponent(slug)}/test`,
      undefined,
      { "x-lambdock-target": String(target) },
    );
  }

  /** Creates a version from the draft and makes it live. The gate runs first. */
  publish(slug: string, opts: { note?: string; force?: boolean } = {}): Promise<PublishResult> {
    return this.#post(`/functions/${encodeURIComponent(slug)}/versions`, opts);
  }

  /** Points the live route at a version that already exists. */
  rollback(slug: string, version: number): Promise<FnSummary> {
    return this.#post(`/functions/${encodeURIComponent(slug)}/live`, { version });
  }

  /* ------------------------------------------------------------- invoke ---- */

  /** Runs a function without publishing it. Returns the response of the handler. */
  async invoke(slug: string, opts: {
    path?: string;
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | null;
    target?: Target;
  } = {}): Promise<Response> {
    const sub = (opts.path ?? "/").replace(/^\/*/, "/");
    return await this.raw(
      `/functions/${encodeURIComponent(slug)}/invoke${sub === "/" ? "" : sub}`,
      {
        method: opts.method ?? "GET",
        headers: { "x-lambdock-target": String(opts.target ?? "draft"), ...opts.headers },
        body: opts.body ?? null,
      },
    );
  }

  /* --------------------------------------------------------------- flow ---- */

  /**
   * Saves the draft and publishes it. Creates the function when it is new.
   * The server runs the type check and the tests before the version exists.
   */
  async deploy(slug: string, body: {
    source: string;
    tests?: string | null;
    lang?: Lang;
    note?: string;
    force?: boolean;
  }): Promise<PublishResult> {
    const exists = await this.get(slug).then(() => true).catch((e) => {
      if (e instanceof LambdockError && e.status === 404) return false;
      throw e;
    });
    if (!exists) {
      // publish: false, so the gate below decides whether version 1 exists at all.
      await this.create(slug, {
        source: body.source,
        tests: body.tests ?? undefined,
        publish: false,
        lang: body.lang,
      });
    } else {
      await this.save(slug, { source: body.source, tests: body.tests, lang: body.lang });
    }
    return await this.publish(slug, { note: body.note, force: body.force });
  }

  /** Yields log lines as they happen. Stop with the signal. */
  async *streamLogs(signal?: AbortSignal): AsyncGenerator<LogLine> {
    const res = await this.raw("/logs/stream", { signal });
    if (!res.ok || !res.body) throw new LambdockError(res.status, "log stream failed", null);
    const lines = res.body.pipeThrough(new TextDecoderStream());
    let buffer = "";
    for await (const chunk of lines) {
      buffer += chunk;
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            yield JSON.parse(line.slice(6)) as LogLine;
          } catch { /* a partial frame is dropped */ }
        }
      }
    }
  }
}
