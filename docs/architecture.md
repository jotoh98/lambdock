# Architecture

lambdock is one Deno process. It serves the editor, the admin API and all functions on one port.

```
                Deno.serve
                    │
    ┌───────────────┼────────────────┐
    │               │                │
/  →redirect    /__/…             /<name>/…
                admin.ts          registry → runtime
                    │                │
               ui/ + JSON API   dynamic import
                    │                │
                    └──── store ─────┘
                        data/
```

## Modules

| File                    | Task                                                      |
| ----------------------- | --------------------------------------------------------- |
| `src/main.ts`           | The server. Splits the URL and chooses the function.      |
| `src/registry.ts`       | Loads modules, compiles routes, matches a path.           |
| `src/runtime.ts`        | Builds the context, runs the handler, makes the response. |
| `src/store.ts`          | Reads and writes `data/`.                                 |
| `src/admin.ts`          | The editor API and the static files.                      |
| `src/console.ts`        | Sends `console.*` of a handler to its log panel.          |
| `src/logs.ts`           | Ring buffer and the live stream.                          |
| `src/kv.ts`             | One key-value namespace per function.                     |
| `src/typecheck.ts`      | Runs `deno check` in a subprocess.                        |
| `src/tests.ts`          | Runs `deno test` in a subprocess.                         |
| `templates/lambdock.ts` | The public type contract. Copied into `data/`.            |

## Why routes cannot collide

Each function owns exactly one first path segment. The router does not merge the routes of different
functions into one table, so two functions cannot compete for the same URL.

A name must match `^[a-z0-9][a-z0-9-]{0,62}$`. The editor lives below `/__`, which starts with an
underscore. A function name cannot start with an underscore. Therefore a function can never take the
URL of the editor.

The check is in `validateSlug()` and in the directory listing. A directory that does not match the
pattern is ignored.

## Why URLPattern

`URLPattern` is in Deno. It gives the `:param`, `:param?` and `*` format that Express, React Router
and many other routers use. There is no dependency, and no new syntax to learn.

One detail: a pattern like `/:name?` makes the leading slash part of the optional group. It matches
`""` but not `"/"`. `matchRoute()` therefore tries the root path both as `/` and as an empty string.

## Draft and versions

A save writes `handler.ts`. It does not change what a request gets. Only a version does.

```
data/functions/hello/       the draft: handler.ts, handler.test.ts, meta.json
data/functions/hello@1/     version 1: handler.ts, handler.test.ts
data/functions/hello@2/     version 2: handler.ts
```

`meta.json` holds `liveVersion` and the list of versions. `registry.load()` imports the file of
`liveVersion`, never the draft, unless nothing is published at all.

### Why a snapshot is a sibling directory

A handler imports the contract as `../../lambdock.ts`. That specifier is relative to the file, so a
snapshot must sit at the same depth as the draft. `functions/hello/versions/2/handler.ts` would
resolve the import to `functions/hello/lambdock.ts`, which does not exist.

`functions/hello@2/handler.ts` has the same depth as `functions/hello/handler.ts`, so the import
resolves to the same file. `@` is not in the slug pattern, so:

- `listSlugs()` skips the directory.
- `hasFn()` refuses the name, so the router gives 404 and the admin API gives "not found".
- `validateSlug()` never lets a user create a function that collides with a snapshot.

The last two matter: without them `GET /hello@2` would find a `handler.ts` and serve it.

### The cache key of the live entry

`registry.get()` runs at each request and must be cheap. The draft mtime is not enough any more,
because a publish or a rollback changes the selection without changing any handler file.

The key is therefore the mtime of `meta.json`. Every state change goes through `writeMeta()`, so a
publish, a rollback and an enable all invalidate the entry. A draft-only entry additionally follows
the draft mtime, so an external edit still shows up in the editor.

### The gate

`POST /__/api/functions/<slug>/versions` runs `deno check` and then `deno test` on the draft. A
failure gives 422 with both results and no version is created. `force: true` creates it and records
`check` or `tests` as `"forced"`, so the history says how the version got there.

The first version of a new function skips the gate, and records both as `"skipped"`. A new function
has no live route to protect.

### The test dependency is in the image

A test file runs with `--no-config`, inside `data/functions/<slug>/`, where no import map exists. It
therefore names its assertions in full: `jsr:@std/assert@^1.0.10`. Without help, the first publish
in a fresh container would download that, and an offline container could never publish at all.

The `Dockerfile` runs `deno cache "jsr:@std/assert@^1.0.10"` for that reason. A test that imports
something else still needs the network the first time.

### Why the tests run with --allow-all

A test file is a separate process. The permissions of the server do not apply to a child process, so
a narrower flag set would give no real protection. `--allow-run`, which the server needs for the
type check as well, is the actual trust boundary.

Tests get an in-memory `ctx.kv` from `testCtx()`, so a test run cannot change stored data.

## How a save reloads a function

Deno caches a module by its full URL. A query string makes a new URL, and therefore a new module:

```ts
import("file:///data/functions/hello/handler.ts?v=1788804466300");
```

The value is the modification time of the file that was imported, which is a version snapshot in the
normal case, and the draft when nothing is published. `registry.get()` compares the state on disk
with the cached entry at each request, so a publish, a rollback or an external edit of an
unpublished draft gives a new URL and a fresh module.

**Cost 1:** the old module stays in the V8 module map. Memory grows a little at each version. This
is acceptable for a dev server. Restart after very many versions.

**Cost 2:** only `handler.ts` gets a new URL. A file that it imports, such as `./lib/db.ts`, keeps
its URL and comes from the module cache. A change to a helper file therefore needs a server restart.

A file watcher on `data/functions` reloads a changed function at once, so the editor shows the new
routes without a request.

## Why one process, not one isolate per function

A Deno `Worker` gives a real V8 isolate and its own permissions. lambdock does not use one, for
these reasons:

- A `Request` and a `Response` cannot cross a worker boundary. Streams, headers and bodies would
  need a serialisation layer.
- A worker start adds latency to a cold call.
- The target is a trusted dev server, where auth is not a concern.

The result: functions share the process, the permissions and the memory. Run only code that you
trust. If you need isolation, put each function in its own container, or look at the Supabase Edge
Runtime or Deno Deploy, which solve that problem with a custom runtime.

## Logs and AsyncLocalStorage

`installConsoleCapture()` replaces `console.log` one time at start. Each invocation runs inside
`scope.run({ slug, requestId }, ...)`, an `AsyncLocalStorage` from `node:async_hooks`. A
`console.log` inside a handler reads the store and finds the function that it belongs to, also after
an `await`.

Output still goes to stdout, so the container log stays complete.

## Type check

The editor runs `deno check` in a subprocess after each save. Two details matter:

- `--no-config`, because the `deno.json` of the project excludes `data/`. With the config, the check
  silently skipped every handler.
- `NO_COLOR=1`, so the output has no escape sequences.

The check needs `--allow-run`. Without that permission it is skipped, and the editor says so. It
does not fail.

## Three layers of tests

| Layer                   | What it runs                                  | What it can catch                          |
| ----------------------- | --------------------------------------------- | ------------------------------------------ |
| `src/lambdock_test.ts`  | The server in this process, `handle(request)` | Routing, the registry, the gate, the store |
| `client/client_test.ts` | A server subprocess, driven over HTTP         | The admin API and the client together      |
| `e2e/container_test.ts` | The built image, in a container               | The Dockerfile and everything above it     |

The unit layer is fast and covers the logic. It cannot see the `Dockerfile`, the module cache in the
image, or the port mapping — a container test can. It caught one real defect: the test dependency
was not in the image, so a fresh container had to download it at the first publish, and an offline
container could never publish at all.

`e2e/container.ts` finds docker or podman, builds the image when the tag is missing, picks a free
port with `Deno.listen({ port: 0 })` (podman refuses a host port of `0`) and removes the container
afterwards. `deno task test` names `src/` on purpose, so the usual test run never starts a
container.

## Atomic writes

`writeAtomic()` writes to `<file>.<random>.tmp` and then renames it. A rename in the same directory
is atomic on Linux and macOS. A crash during a save cannot leave a half-written `handler.ts`.

The file watcher ignores names that end with `.tmp`.

## The editor bundle

`ui/vendor/editor.js` holds CodeMirror 6. It is built with `deno bundle` from
`scripts/editor-entry.ts` and committed, so the container needs no npm access. The release workflow
rebuilds it before the image build.

The bundle is a classic script and declares its own names in the global scope. `ui/app.js` is
therefore inside an IIFE. Without it, the minified bundle and the application both declared `$`, and
the whole page failed.

If the bundle does not load, the editor falls back to a plain text area. Save, test and logs
continue to work.

## What is not here

- **No authentication.** See the limits in the README. Anybody who reaches the port can publish a
  version and roll one back.
- **No build step for functions.** Deno runs TypeScript directly.
- **No data versioning.** A rollback restores the code, not the `ctx.kv` content.
- **No cold start.** Every function is loaded at start.
