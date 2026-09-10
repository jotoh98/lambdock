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
  /** Set to "0" to skip `deno test` before a version is created. */
  runTests: env("LAMBDOCK_TESTS", "1") !== "0",
  /** Milliseconds before a test run is killed. */
  testTimeoutMs: Number(env("LAMBDOCK_TEST_TIMEOUT_MS", "60000")),
} as const;

/**
 * A version snapshot is a sibling directory of the draft, named `<slug>@<n>`.
 * The depth must match the draft, because a handler imports `../../lambdock.ts`.
 * `@` is not a legal slug character, so a snapshot can never become a function.
 */
const versionSlug = (slug: string, version: number) => `${slug}@${version}`;

/** The language of a function. It is the extension of its handler and test files. */
export type Lang = "ts" | "tsx";

export const LANGS: readonly Lang[] = ["ts", "tsx"];

export const handlerName = (lang: Lang) => `handler.${lang}`;
export const testsName = (lang: Lang) => `handler.test.${lang}`;

export const paths = {
  functions: () => resolve(config.dataDir, "functions"),
  fnDir: (slug: string) => resolve(config.dataDir, "functions", slug),
  meta: (slug: string) => resolve(config.dataDir, "functions", slug, "meta.json"),
  versionDir: (slug: string, v: number) =>
    resolve(config.dataDir, "functions", versionSlug(slug, v)),
  envFile: () => resolve(config.dataDir, "env.json"),
  kvFile: () => resolve(config.dataDir, "kv.sqlite"),
  typesFile: () => resolve(config.dataDir, "lambdock.ts"),
  /** No extension: `@jsxImportSource ../../jsx` resolves to exactly this path. */
  jsxRuntime: () => resolve(config.dataDir, "jsx", "jsx-runtime"),
};

/** True for a directory that holds a version snapshot, not a function. */
export function isVersionDir(name: string): boolean {
  return name.includes("@");
}
