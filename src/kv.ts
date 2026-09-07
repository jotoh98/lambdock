import { paths } from "./config.ts";
import type { FnKv } from "../templates/lambdock.ts";

let kv: Deno.Kv | null = null;

export async function openKv(): Promise<Deno.Kv> {
  if (!kv) kv = await Deno.openKv(paths.kvFile());
  return kv;
}

export function closeKv() {
  kv?.close();
  kv = null;
}

/** Gives a function a private namespace inside the shared KV database. */
export function kvFor(slug: string): FnKv {
  const ns = ["fn", slug];
  return {
    async get<T>(key: string) {
      const r = await (await openKv()).get<T>([...ns, key]);
      return r.value ?? null;
    },
    async set(key, value, opts) {
      await (await openKv()).set([...ns, key], value, opts);
    },
    async delete(key) {
      await (await openKv()).delete([...ns, key]);
    },
    async list<T>(prefix = "") {
      const out: Array<{ key: string; value: T }> = [];
      const iter = (await openKv()).list<T>({ prefix: prefix ? [...ns, prefix] : ns });
      for await (const e of iter) {
        out.push({ key: String(e.key[e.key.length - 1]), value: e.value });
      }
      return out;
    },
  };
}

/** Removes all keys of a function. Used when a function is deleted. */
export async function dropNamespace(slug: string) {
  const db = await openKv();
  const iter = db.list({ prefix: ["fn", slug] });
  for await (const e of iter) await db.delete(e.key);
}
