import { toFileUrl } from "@std/path";
import { paths } from "./config.ts";
import { scope } from "./console.ts";
import * as logs from "./logs.ts";

/**
 * Keeps the server alive when a function fails outside a request.
 * Top-level code of a handler module keeps running after `import` resolves,
 * so a promise it starts rejects behind the back of the registry try/catch.
 * Without this guard one bad function stops all functions.
 */
export function installCrashGuard() {
  const write = console.error.bind(console);

  globalThis.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    report(write, "unhandled rejection", event.reason);
  });

  globalThis.addEventListener("error", (event) => {
    event.preventDefault();
    report(write, "uncaught error", event.error ?? event.message);
  });
}

/** Reads the function slug from a stack trace that points into the data directory. */
export function slugFromStack(stack: string): string | null {
  const dir = toFileUrl(paths.functions()).href + "/";
  const at = stack.indexOf(dir);
  if (at === -1) return null;
  const slug = stack.slice(at + dir.length).split(/[/?#\s)]/)[0];
  return slug || null;
}

function report(write: (...args: unknown[]) => void, kind: string, value: unknown) {
  const err = value instanceof Error ? value : new Error(String(value));
  const text = `${kind}: ${err.name}: ${err.message}\n${err.stack ?? ""}`.trim();
  const active = scope.getStore();
  const slug = active?.slug ?? (err.stack ? slugFromStack(err.stack) : null);

  if (slug) {
    logs.push({
      ts: Date.now(),
      slug,
      requestId: active?.requestId ?? "-",
      level: "error",
      text,
    });
  }
  write(slug ? `[${slug}] ${text}` : text);
}
