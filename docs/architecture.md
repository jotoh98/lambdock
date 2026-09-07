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

## How a save reloads a function

Deno caches a module by its full URL. A query string makes a new URL, and therefore a new module:

```ts
import("file:///data/functions/hello/handler.ts?v=1788804466300");
```

The value is the modification time of the file. `registry.get()` compares the time on disk with the
time of the cached entry at each request. A change on disk, from the editor or from your own editor,
gives a new URL and a fresh module.

**Cost 1:** the old module stays in the V8 module map. Memory grows a little at each save. This is
acceptable for a dev server. Restart after very many saves.

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

- **No authentication.** See the limits in the README.
- **No build step for functions.** Deno runs TypeScript directly.
- **No versioning of functions.** `data/` is a normal directory. Put it in git if you want a
  history.
- **No cold start.** Every function is loaded at start.
