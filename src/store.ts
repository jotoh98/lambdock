import { paths } from "./config.ts";

export interface FnMeta {
  slug: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
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

export async function init() {
  await Deno.mkdir(paths.functions(), { recursive: true });
  // Refresh the public type file so handlers always see the current contract.
  const types = await Deno.readTextFile(
    new URL("../templates/lambdock.ts", import.meta.url),
  );
  await writeAtomic(paths.typesFile(), types);
  if (!(await exists(paths.envFile()))) await writeAtomic(paths.envFile(), "{}\n");
}

export async function listSlugs(): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(paths.functions())) {
    if (e.isDirectory && SLUG_RE.test(e.name)) out.push(e.name);
  }
  return out.sort();
}

export async function hasFn(slug: string): Promise<boolean> {
  return await exists(paths.handler(slug));
}

export async function readMeta(slug: string): Promise<FnMeta> {
  try {
    return JSON.parse(await Deno.readTextFile(paths.meta(slug)));
  } catch {
    const now = new Date().toISOString();
    return { slug, enabled: true, createdAt: now, updatedAt: now };
  }
}

export async function writeMeta(slug: string, meta: FnMeta) {
  await writeAtomic(paths.meta(slug), JSON.stringify(meta, null, 2) + "\n");
}

export async function readSource(slug: string): Promise<string> {
  return await Deno.readTextFile(paths.handler(slug));
}

/** Returns the modification time in milliseconds. It is the cache key of the module. */
export async function sourceVersion(slug: string): Promise<number> {
  const st = await Deno.stat(paths.handler(slug));
  return st.mtime?.getTime() ?? 0;
}

export async function createFn(slug: string, source: string): Promise<FnMeta> {
  await Deno.mkdir(paths.fnDir(slug), { recursive: true });
  const now = new Date().toISOString();
  const meta: FnMeta = { slug, enabled: true, createdAt: now, updatedAt: now };
  await writeAtomic(paths.handler(slug), source);
  await writeMeta(slug, meta);
  return meta;
}

export async function writeSource(slug: string, source: string): Promise<FnMeta> {
  await writeAtomic(paths.handler(slug), source);
  const meta = await readMeta(slug);
  meta.updatedAt = new Date().toISOString();
  await writeMeta(slug, meta);
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
  await Deno.remove(paths.fnDir(slug), { recursive: true });
}

export async function renameFn(from: string, to: string) {
  await Deno.rename(paths.fnDir(from), paths.fnDir(to));
  const meta = await readMeta(to);
  meta.slug = to;
  meta.updatedAt = new Date().toISOString();
  await writeMeta(to, meta);
}

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

/** Returns the source used for a newly created function. */
export async function newFunctionTemplate(): Promise<string> {
  return await Deno.readTextFile(new URL("../templates/new-function.ts", import.meta.url));
}

/** Seeds the example functions if the data directory holds none. */
export async function seedExamples(): Promise<string[]> {
  if ((await listSlugs()).length > 0) return [];
  const dir = new URL("../templates/examples/", import.meta.url);
  const seeded: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile || !e.name.endsWith(".ts")) continue;
    const slug = e.name.replace(/\.ts$/, "");
    await createFn(slug, await Deno.readTextFile(new URL(e.name, dir)));
    seeded.push(slug);
  }
  return seeded;
}
