import { resolve } from "@std/path";

const env = (k: string, d: string) => Deno.env.get(k) ?? d;

export const config = {
  /** Directory that holds functions, env store and KV. Mount it as a volume. */
  dataDir: resolve(env("LAMBDOCK_DATA", "./data")),
  host: env("LAMBDOCK_HOST", "0.0.0.0"),
  port: Number(env("LAMBDOCK_PORT", "8000")),
  /** Prefix of the editor and the admin API. Function slugs cannot use it. */
  adminPrefix: "/__",
  /** Default milliseconds before a request is aborted. */
  defaultTimeoutMs: Number(env("LAMBDOCK_TIMEOUT_MS", "30000")),
  /** Number of log lines kept per function. */
  logBuffer: Number(env("LAMBDOCK_LOG_BUFFER", "300")),
  /** Set to "0" to disable `deno check` on save. */
  typeCheck: env("LAMBDOCK_TYPECHECK", "1") !== "0",
} as const;

export const paths = {
  functions: () => resolve(config.dataDir, "functions"),
  fnDir: (slug: string) => resolve(config.dataDir, "functions", slug),
  handler: (slug: string) => resolve(config.dataDir, "functions", slug, "handler.ts"),
  meta: (slug: string) => resolve(config.dataDir, "functions", slug, "meta.json"),
  envFile: () => resolve(config.dataDir, "env.json"),
  kvFile: () => resolve(config.dataDir, "kv.sqlite"),
  typesFile: () => resolve(config.dataDir, "lambdock.ts"),
};
