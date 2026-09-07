import { AsyncLocalStorage } from "node:async_hooks";
import { format, push } from "./logs.ts";

export interface InvocationScope {
  slug: string;
  requestId: string;
}

export const scope = new AsyncLocalStorage<InvocationScope>();

let installed = false;

/**
 * Routes `console.*` calls made inside a handler to the log panel of that function.
 * AsyncLocalStorage keeps the link across `await` boundaries.
 * Output still goes to stdout, so container logs stay complete.
 */
export function installConsoleCapture() {
  if (installed) return;
  installed = true;
  const levels = ["log", "info", "warn", "error", "debug"] as const;
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const s = scope.getStore();
      if (s) {
        push({
          ts: Date.now(),
          slug: s.slug,
          requestId: s.requestId,
          level,
          text: format(args),
        });
        original(`[${s.slug}]`, ...args);
      } else {
        original(...args);
      }
    };
  }
}
