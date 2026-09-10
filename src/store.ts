import { dirname, join } from "@std/path";
import { handlerName, isVersionDir, type Lang, LANGS, paths, testsName } from "./config.ts";

/** One published, immutable snapshot of a function. */
export interface VersionMeta {
  version: number;
  createdAt: string;
  note: string;
  /** sha-256 of the handler source. Tells whether the draft still equals this version. */
  hash: string;
  /** Outcome of the gate that ran before the snapshot was taken. */
  check: GateResult;
  tests: GateResult;
}

export type GateResult = "passed" | "none" | "skipped" | "forced";

export interface FnMeta {
  slug: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Version that answers requests. `null` means the function has a draft only. */
  liveVersion: number | null;
  versions: VersionMeta[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * A slug must start with a letter or a digit. The admin prefix starts with "_".
 * Therefore a function route can never collide with the editor or the admin API.
 */
export function validateSlug(slug: string): string | null {
  if (!SLUG_RE.test(slug)) {
    return "Use 1-63 characters: lowercase letters, digits and '-'. Start with a letter or a digit.";
  }
  return null;
}

/** Writes through a temporary file and renames it. A crash cannot leave a partial file. */
async function writeAtomic(path: string, data: string) {
  const tmp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await Deno.writeTextFile(tmp, data);
  await Deno.rename(tmp, path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

async function removeIfPresent(path: string) {
  try {
    await Deno.remove(path, { recursive: true });
  } catch { /* already gone */ }
}

export async function hash(source: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isLang(value: unknown): value is Lang {
  return LANGS.includes(value as Lang);
}

export interface FnFiles {
  lang: Lang;
  handler: string;
  tests: string;
}

/**
 * Finds the files of the draft, or of one version.
 * The handler on disk sets the language. A handler.tsx wins over a handler.ts.
 */
export async function filesOf(slug: string, version?: number): Promise<FnFiles> {
  const dir = version === undefined ? paths.fnDir(slug) : paths.versionDir(slug, version);
  const lang: Lang = (await exists(join(dir, handlerName("tsx")))) ? "tsx" : "ts";
  return { lang, handler: join(dir, handlerName(lang)), tests: join(dir, testsName(lang)) };
}

export async function init() {
  await Deno.mkdir(paths.functions(), { recursive: true });
  // Refresh the public type file and the JSX runtime so handlers always see the current contract.
  const types = await Deno.readTextFile(
    new URL("../templates/lambdock.ts", import.meta.url),
  );
  await writeAtomic(paths.typesFile(), types);
  const runtime = await Deno.readTextFile(
    new URL("../templates/jsx/jsx-runtime.ts", import.meta.url),
  );
  await Deno.mkdir(dirname(paths.jsxRuntime()), { recursive: true });
  await writeAtomic(paths.jsxRuntime(), runtime);
  if (!(await exists(paths.envFile()))) await writeAtomic(paths.envFile(), "{}\n");
}

export async function listSlugs(): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(paths.functions())) {
    if (e.isDirectory && !isVersionDir(e.name) && SLUG_RE.test(e.name)) out.push(e.name);
  }
  return out.sort();
}

export async function hasFn(slug: string): Promise<boolean> {
  // A version snapshot lives in a sibling directory and holds a handler too.
  // The slug check keeps it out of the router and out of the admin API.
  if (validateSlug(slug) !== null) return false;
  return await exists((await filesOf(slug)).handler);
}

function emptyMeta(slug: string): FnMeta {
  const now = new Date().toISOString();
  return { slug, enabled: true, createdAt: now, updatedAt: now, liveVersion: null, versions: [] };
}

export async function readMeta(slug: string): Promise<FnMeta> {
  try {
    const raw = JSON.parse(await Deno.readTextFile(paths.meta(slug)));
    // A meta file written before versioning existed has neither field.
    return { ...emptyMeta(slug), ...raw, versions: raw.versions ?? [] };
  } catch {
    return emptyMeta(slug);
  }
}

export async function writeMeta(slug: string, meta: FnMeta) {
  await writeAtomic(paths.meta(slug), JSON.stringify(meta, null, 2) + "\n");
}

/** Modification time of `meta.json` in milliseconds. It is the cache key of the live entry. */
export async function metaVersion(slug: string): Promise<number> {
  try {
    return (await Deno.stat(paths.meta(slug))).mtime?.getTime() ?? 0;
  } catch {
    return 0;
  }
}

/* ---------------------------------------------------------------- draft ---- */

export async function readSource(slug: string): Promise<string> {
  return await Deno.readTextFile((await filesOf(slug)).handler);
}

export async function readTests(slug: string): Promise<string | null> {
  return await readOrNull((await filesOf(slug)).tests);
}

/** Returns the modification time in milliseconds. It is the cache key of the module. */
export async function sourceVersion(slug: string): Promise<number> {
  const st = await Deno.stat((await filesOf(slug)).handler);
  return st.mtime?.getTime() ?? 0;
}

async function touchMeta(slug: string): Promise<FnMeta> {
  const meta = await readMeta(slug);
  meta.updatedAt = new Date().toISOString();
  await writeMeta(slug, meta);
  return meta;
}

export async function writeSource(slug: string, source: string): Promise<FnMeta> {
  await writeAtomic((await filesOf(slug)).handler, source);
  return await touchMeta(slug);
}

export async function writeTests(slug: string, source: string | null): Promise<FnMeta> {
  const { tests } = await filesOf(slug);
  if (source === null) await removeIfPresent(tests);
  else await writeAtomic(tests, source);
  return await touchMeta(slug);
}

/**
 * Gives the draft files the extension of `lang`. The text does not change.
 * An import of `./handler.ts` in the tests must then be changed by hand.
 */
export async function setLang(slug: string, lang: Lang): Promise<FnMeta> {
  const from = await filesOf(slug);
  if (from.lang === lang) return await readMeta(slug);
  const dir = paths.fnDir(slug);
  await Deno.rename(from.handler, join(dir, handlerName(lang)));
  try {
    await Deno.rename(from.tests, join(dir, testsName(lang)));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return await touchMeta(slug);
}

/** True when the draft differs from the version that is live. */
export async function draftIsAhead(slug: string): Promise<boolean> {
  const meta = await readMeta(slug);
  const live = meta.versions.find((v) => v.version === meta.liveVersion);
  if (!live) return true;
  const [draft, snapshot] = await Promise.all([filesOf(slug), filesOf(slug, live.version)]);
  if (draft.lang !== snapshot.lang) return true;
  return (await hash(await Deno.readTextFile(draft.handler))) !== live.hash;
}

/* -------------------------------------------------------------- versions ---- */

/** Copies the draft into a new immutable snapshot and returns its metadata. */
export async function createVersion(
  slug: string,
  gate: { note?: string; check: GateResult; tests: GateResult },
): Promise<VersionMeta> {
  const meta = await readMeta(slug);
  const version = meta.versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;
  const files = await filesOf(slug);
  const source = await Deno.readTextFile(files.handler);
  const tests = await readOrNull(files.tests);

  const dir = paths.versionDir(slug, version);
  await Deno.mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, handlerName(files.lang)), source);
  if (tests !== null) await writeAtomic(join(dir, testsName(files.lang)), tests);

  const entry: VersionMeta = {
    version,
    createdAt: new Date().toISOString(),
    note: gate.note ?? "",
    hash: await hash(source),
    check: gate.check,
    tests: gate.tests,
  };
  meta.versions.push(entry);
  meta.liveVersion = version;
  meta.updatedAt = entry.createdAt;
  await writeMeta(slug, meta);
  return entry;
}

/** Points the live route at a version that already exists. */
export async function setLiveVersion(slug: string, version: number): Promise<FnMeta> {
  const meta = await readMeta(slug);
  if (!meta.versions.some((v) => v.version === version)) {
    throw new Deno.errors.NotFound(`Version ${version} of "${slug}" does not exist.`);
  }
  meta.liveVersion = version;
  meta.updatedAt = new Date().toISOString();
  await writeMeta(slug, meta);
  return meta;
}

export async function readVersionSource(slug: string, version: number): Promise<string> {
  return await Deno.readTextFile((await filesOf(slug, version)).handler);
}

export async function readVersionTests(slug: string, version: number): Promise<string | null> {
  return await readOrNull((await filesOf(slug, version)).tests);
}

/** Returns the modification time of a snapshot, for the module cache key. */
export async function versionMtime(slug: string, version: number): Promise<number> {
  try {
    return (await Deno.stat((await filesOf(slug, version)).handler)).mtime?.getTime() ?? 0;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------ lifecycle ---- */

export async function createFn(
  slug: string,
  source: string,
  opts: { tests?: string; publish?: boolean; lang?: Lang } = {},
): Promise<FnMeta> {
  const dir = paths.fnDir(slug);
  const lang = opts.lang ?? "ts";
  await Deno.mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const meta: FnMeta = {
    slug,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    liveVersion: null,
    versions: [],
  };
  await writeAtomic(join(dir, handlerName(lang)), source);
  if (opts.tests) await writeAtomic(join(dir, testsName(lang)), opts.tests);
  await writeMeta(slug, meta);
  // A brand new function has nothing live to break, so version 1 goes live at once.
  // Every later save is a draft until a version is created.
  if (opts.publish !== false) {
    // "skipped" and not "passed": the gate does not run for the first version.
    await createVersion(slug, { note: "initial", check: "skipped", tests: "skipped" });
    return await readMeta(slug);
  }
  return meta;
}

export async function setEnabled(slug: string, enabled: boolean): Promise<FnMeta> {
  const meta = await readMeta(slug);
  meta.enabled = enabled;
  meta.updatedAt = new Date().toISOString();
  await writeMeta(slug, meta);
  return meta;
}

export async function deleteFn(slug: string) {
  const meta = await readMeta(slug);
  for (const v of meta.versions) await removeIfPresent(paths.versionDir(slug, v.version));
  await Deno.remove(paths.fnDir(slug), { recursive: true });
}

export async function renameFn(from: string, to: string) {
  const meta = await readMeta(from);
  await Deno.rename(paths.fnDir(from), paths.fnDir(to));
  for (const v of meta.versions) {
    try {
      await Deno.rename(paths.versionDir(from, v.version), paths.versionDir(to, v.version));
    } catch { /* a snapshot that is gone does not stop the rename */ }
  }
  meta.slug = to;
  meta.updatedAt = new Date().toISOString();
  await writeMeta(to, meta);
}

/* -------------------------------------------------------------------- env ---- */

export async function readEnv(): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await Deno.readTextFile(paths.envFile()));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = String(v);
    return out;
  } catch {
    return {};
  }
}

export async function writeEnv(env: Record<string, string>) {
  await writeAtomic(paths.envFile(), JSON.stringify(env, null, 2) + "\n");
}

/* -------------------------------------------------------------- templates ---- */

/** Returns the source used for a newly created function. */
export async function newFunctionTemplate(lang: Lang = "ts"): Promise<string> {
  return await Deno.readTextFile(new URL(`../templates/new-function.${lang}`, import.meta.url));
}

/** Returns the test file used for a newly created function. */
export async function newTestTemplate(lang: Lang = "ts"): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../templates/new-function.test.${lang}`, import.meta.url),
  );
}

/** Seeds the example functions if the data directory holds none. */
export async function seedExamples(): Promise<string[]> {
  if ((await listSlugs()).length > 0) return [];
  const dir = new URL("../templates/examples/", import.meta.url);
  const seeded: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    // `x.test.ts` does not match: a slug has no dot.
    const m = e.name.match(/^([a-z0-9-]+)\.(tsx?)$/);
    if (!e.isFile || !m) continue;
    const slug = m[1];
    const lang = m[2] as Lang;
    let tests: string | undefined;
    try {
      tests = await Deno.readTextFile(new URL(`${slug}.test.${lang}`, dir));
    } catch { /* an example without tests is fine */ }
    await createFn(slug, await Deno.readTextFile(new URL(e.name, dir)), { tests, lang });
    seeded.push(slug);
  }
  return seeded.sort();
}
