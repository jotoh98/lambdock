# Write a function

A function is one TypeScript module at `data/functions/<name>/handler.ts`. It must have a default
export that is a function.

The smallest function:

```ts
export default () => "hello";
```

Save it as `ping`, and `GET /ping` gives `hello`.

## A save is a draft

Saving writes `handler.ts`. The live route keeps serving the version it had. Create a version to
change what a request gets:

```bash
lambdock push hello        # save the draft
lambdock test hello        # run handler.test.ts against the draft
lambdock publish hello     # deno check + tests, then live
```

In the editor: `Cmd`/`Ctrl` + `S` saves, the **Publish** button creates a version, and the
**Versions** tab makes an older one live again.

The first version of a new function goes live at once, because there is nothing to break yet.

## Tests

Put them in `handler.test.ts`, next to the handler:

```ts
import { assertEquals } from "jsr:@std/assert@^1.0.10";
import { callFn, memoryKv } from "../../lambdock.ts";
import handler from "./handler.ts";

Deno.test("the root answers", async () => {
  const res = await callFn(handler, "/");
  assertEquals(res.status, 200);
});

Deno.test("a parameter is used", async () => {
  const res = await callFn(handler, "/42", { params: { id: "42" } });
  assertEquals((await res.json()).id, "42");
});

Deno.test("two calls share one store", async () => {
  const kv = memoryKv();
  await callFn(handler, new Request("http://x/", { method: "POST", body: "{}" }), { kv });
  const res = await callFn(handler, "/");
  assertEquals(res.status, 200);
});
```

| Helper                       | What it gives you                                        |
| ---------------------------- | -------------------------------------------------------- |
| `callFn(handler, req, ctx?)` | Calls the handler as the server does, returns a Response |
| `testCtx(partial?)`          | A `Ctx` with usable defaults                             |
| `memoryKv()`                 | A `FnKv` in memory, so tests never touch stored data     |

`req` is a `Request` or a path string. `ctx` sets `params`, `env`, `kv`, `path` and the rest.

The tests run against the draft on disk, in a `deno test` subprocess with full permissions. They
must pass before a version can be created. Publish with `force` to go ahead anyway.

## The module contract

```ts
import type { Ctx, FnConfig } from "../../lambdock.ts";

export const config: FnConfig = {/* optional */};

export default function handler(req: Request, ctx: Ctx) {/* ... */}
```

`data/lambdock.ts` is written at each server start. Do not edit it. It always matches the version of
the server.

## Routes

```ts
export const config: FnConfig = {
  routes: [
    { method: "GET", path: "/" },
    { method: "GET", path: "/:id" },
    { method: "PUT", path: "/:id" },
    { method: "*", path: "/:id/files/*" },
  ],
};
```

Each `path` is relative to the mount point. A function named `notes` with the path `/:id` answers on
`/notes/42`.

If you give no `routes`, the function receives every method on every sub-path. That is the same as
`[{ method: "*", path: "/*" }]`.

Routes are tried in order. The first match wins. Put the specific routes first.

### Pattern syntax

The patterns come from the built-in `URLPattern`.

| Pattern      | Matches              | `ctx.params`           |
| ------------ | -------------------- | ---------------------- |
| `/`          | `/`                  | `{}`                   |
| `/:id`       | `/42`                | `{ id: "42" }`         |
| `/:id?`      | `/` and `/42`        | `{}` or `{ id: "42" }` |
| `/a/:b/c/:d` | `/a/1/c/2`           | `{ b: "1", d: "2" }`   |
| `/files/*`   | `/files/x/y.txt`     | `{ "0": "x/y.txt" }`   |
| `/:id(\\d+)` | `/42` but not `/abc` | `{ id: "42" }`         |

Parameter values are decoded with `decodeURIComponent`.

A trailing slash is removed before the match. `/notes/42/` and `/notes/42` go to the same route.

### The method

`method` is one HTTP method, or `*` for all of them. It is not case-sensitive.

A request that finds the function but no route gets 404 with a list of the routes that exist:

```json
{
  "error": "no_matching_route",
  "function": "notes",
  "path": "/42/x",
  "method": "GET",
  "routes": ["GET /notes", "GET /notes/:id"]
}
```

## The context

```ts
interface Ctx {
  params: Record<string, string>; // path parameters
  url: URL; // the full request URL
  path: string; // the path after the mount point
  slug: string; // the name of this function
  requestId: string; // unique for each invocation
  env: Record<string, string>; // the shared environment store
  kv: FnKv; // storage that stays after a reboot
  log: (...args: unknown[]) => void;
  signal: AbortSignal; // aborts on a timeout or a cancelled request
}
```

## Return values

You can return a `Response` for full control:

```ts
return new Response("not found", { status: 404 });
return Response.json({ ok: true }, { status: 201 });
return new Response(stream, { headers: { "content-type": "text/event-stream" } });
```

Or return a plain value, and lambdock makes the response:

| You return                             | Status | Content type                |
| -------------------------------------- | ------ | --------------------------- |
| `string`                               | 200    | `text/plain; charset=utf-8` |
| `null`, `undefined`                    | 204    | —                           |
| `Uint8Array`, `Blob`, `ReadableStream` | 200    | —                           |
| any other value                        | 200    | `application/json`          |

Every response gets three extra headers:

```
x-lambdock-function: notes
x-lambdock-request-id: 3f9a1c02
x-lambdock-duration-ms: 4
```

## Storage

`ctx.kv` is a key-value store. Each function has its own namespace, so two functions cannot see the
data of each other. The data is in `data/kv.sqlite` and stays after a reboot.

```ts
await ctx.kv.set("user:1", { name: "Ada" });

const user = await ctx.kv.get<User>("user:1"); // the value, or null
const all = await ctx.kv.list<User>("user:"); // [{ key, value }, ...]

await ctx.kv.delete("user:1");
```

`set()` also takes `{ expireIn: milliseconds }`. Deno accepts it, but the local SQLite backend does
not remove the key at that time. Do not use it for correctness. Store an expiry timestamp and test
it yourself:

```ts
await ctx.kv.set("session", { token, until: Date.now() + 60_000 });

const s = await ctx.kv.get<Session>("session");
if (!s || s.until < Date.now()) return new Response("expired", { status: 401 });
```

When you delete a function, its data is deleted too.

For anything larger, use a normal database. Deno can import npm and JSR packages directly:

```ts
import postgres from "npm:postgres";
const sql = postgres(ctx.env.DATABASE_URL);
```

The first request after a save downloads the package. Later requests use the cache.

## Environment variables

Press **Env** in the editor, or edit `data/env.json`. All functions read the same store.

```ts
const key = ctx.env.OPENAI_API_KEY;
if (!key) return new Response("OPENAI_API_KEY is not set", { status: 500 });
```

The store is read at each request, so a change takes effect at once. No restart is necessary.

`ctx.env` does not contain the process environment of the server. Only what you put in
`data/env.json` is visible.

## Logs

`console.log`, `console.warn` and `console.error` go to the Logs tab of the function, and to the
container log. `ctx.log()` does the same.

```ts
console.log("payload", body);
ctx.log("done in", ms, "ms");
```

The link between a log line and its function works across `await`. It uses `AsyncLocalStorage`.

The server keeps the last 300 lines per function. Change the number with `LAMBDOCK_LOG_BUFFER`.

## Timeouts

```ts
export const config: FnConfig = { timeoutMs: 5000 };
```

After the timeout, the client gets 500. Pass `ctx.signal` to `fetch` so the outgoing request stops
too:

```ts
const res = await fetch(url, { signal: ctx.signal });
```

A timeout ends the response. It does **not** stop code that is already running.

## State between requests

Module-level variables stay alive between requests, because the module is loaded one time:

```ts
const cache = new Map<string, unknown>();

export default (_req: Request, ctx: Ctx) => {
  if (!cache.has(ctx.params.id)) cache.set(ctx.params.id, expensive());
  return cache.get(ctx.params.id);
};
```

A save reloads the module and empties this cache. Use `ctx.kv` for data that must stay.

## Errors

An error in a handler gives 500 with the message and the stack:

```json
{
  "error": "handler_failed",
  "function": "notes",
  "requestId": "3f9a1c02",
  "name": "TypeError",
  "message": "x is not a function",
  "stack": "..."
}
```

The error also appears in the Logs tab. This is useful on a dev server, but it shows internal
detail. Catch your own errors if that matters.

If the **module** cannot load, every request to that function gives 500 with
`function_failed_to_load`. The other functions continue to work.

Code at the top of the module runs one time, at load, with no request around it. A synchronous error
there stops the load and gives `function_failed_to_load`. A promise that the module starts but does
not await fails later: the server catches it, writes it to the Logs tab of that function, and keeps
serving. Do not do work at module level that belongs in the handler — a script that you paste in
often ends with a call such as `main()`, and that call runs at load, not per request.

## Import other files

Put helper files beside `handler.ts`:

```
data/functions/notes/
├── handler.ts
└── lib/db.ts
```

```ts
import { query } from "./lib/db.ts";
```

The editor shows only `handler.ts`. Edit the other files with your own editor.

**A change to a helper file needs a server restart.** The reload gives `handler.ts` a new module
URL, but `./lib/db.ts` keeps its URL, so Deno serves it from the module cache. A `touch` of
`handler.ts` does not help.

```bash
podman restart lambdock     # container
# or stop `deno task start` and start it again
```

Keep a function in one file while you develop it. Split it when it is stable.

## Complete example

```ts
import type { Ctx, FnConfig } from "../../lambdock.ts";

export const config: FnConfig = {
  description: "Short links",
  routes: [
    { method: "POST", path: "/" },
    { method: "GET", path: "/:code" },
  ],
  timeoutMs: 5000,
};

export default async function handler(req: Request, ctx: Ctx) {
  if (req.method === "POST") {
    const { url } = await req.json() as { url?: string };
    if (!url) return new Response("url is required", { status: 400 });

    const code = crypto.randomUUID().slice(0, 6);
    await ctx.kv.set(code, url);
    console.log("created", code, "->", url);

    return Response.json({ code, short: `${ctx.url.origin}/${ctx.slug}/${code}` }, { status: 201 });
  }

  const target = await ctx.kv.get<string>(ctx.params.code);
  if (!target) return new Response("unknown code", { status: 404 });
  return Response.redirect(target, 302);
}
```

```bash
curl -X POST localhost:8000/links -d '{"url":"https://deno.com"}'
# {"code":"a1b2c3","short":"http://localhost:8000/links/a1b2c3"}
curl -i localhost:8000/links/a1b2c3
# HTTP/1.1 302 Found
```
