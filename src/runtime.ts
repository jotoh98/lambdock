import { scope } from "./console.ts";
import { kvFor } from "./kv.ts";
import * as logs from "./logs.ts";
import * as store from "./store.ts";
import type { Match } from "./registry.ts";
import type { Ctx } from "../templates/lambdock.ts";

/** Turns a plain return value into a Response. */
function toResponse(value: unknown): Response {
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

function errorResponse(slug: string, requestId: string, e: unknown): Response {
  const err = e instanceof Error ? e : new Error(String(e));
  logs.push({
    ts: Date.now(),
    slug,
    requestId,
    level: "error",
    text: `${err.name}: ${err.message}\n${err.stack ?? ""}`.trim(),
  });
  return Response.json({
    error: "handler_failed",
    function: slug,
    requestId,
    name: err.name,
    message: err.message,
    stack: err.stack,
  }, { status: 500 });
}

export async function invoke(match: Match, req: Request, path: string): Promise<Response> {
  const { entry, params } = match;
  const requestId = crypto.randomUUID().slice(0, 8);
  const started = performance.now();

  const timer = new AbortController();
  const timeoutId = setTimeout(() => timer.abort(new Error("Function timed out")), entry.timeoutMs);
  const signal = AbortSignal.any([timer.signal, req.signal]);

  const ctx: Ctx = {
    params,
    url: new URL(req.url),
    path,
    slug: entry.slug,
    requestId,
    env: await store.readEnv(),
    kv: kvFor(entry.slug),
    log: (...args: unknown[]) =>
      logs.push({
        ts: Date.now(),
        slug: entry.slug,
        requestId,
        level: "log",
        text: logs.format(args),
      }),
    signal,
  };

  try {
    const result = await scope.run({ slug: entry.slug, requestId }, async () => {
      const run = Promise.resolve(entry.handler!(req, ctx));
      const timeout = new Promise<never>((_, reject) => {
        timer.signal.addEventListener(
          "abort",
          () => reject(new Error(`Timed out after ${entry.timeoutMs} ms`)),
          { once: true },
        );
      });
      return await Promise.race([run, timeout]);
    });

    const res = toResponse(result);
    const ms = Math.round(performance.now() - started);
    const headers = new Headers(res.headers);
    headers.set("x-lambdock-function", entry.slug);
    headers.set("x-lambdock-request-id", requestId);
    headers.set("x-lambdock-duration-ms", String(ms));
    logs.push({
      ts: Date.now(),
      slug: entry.slug,
      requestId,
      level: "system",
      text: `${req.method} ${path} -> ${res.status} in ${ms} ms`,
    });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } catch (e) {
    return errorResponse(entry.slug, requestId, e);
  } finally {
    clearTimeout(timeoutId);
  }
}
