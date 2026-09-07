# lambdock

Self-hosted TypeScript functions on [Deno](https://deno.com), with a web editor.

Write a function in the browser, press save, and it is live. Every function gets its own sub-route
below one host and one port. The files stay on disk, so a reboot does not remove them.

![the editor](docs/editor.png)

## What you get

|                        |                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------- |
| **One host, one port** | Every function is mounted below `/<name>`. Routes cannot collide.                      |
| **Path parameters**    | The standard `:param`, `:param?` and `*` format, from the built-in `URLPattern`.       |
| **Interactive editor** | CodeMirror with TypeScript highlighting, a request tester, live logs and `deno check`. |
| **Reboot-safe**        | Source, settings and function data live in one directory. Mount it as a volume.        |
| **Hot reload**         | A save reloads only the changed function. The server does not restart.                 |
| **Container-ready**    | A multi-architecture image is on the GitHub container registry.                        |

## Quick start

### With podman (recommended for a server)

```bash
mkdir -p ~/lambdock && cd ~/lambdock
curl -O https://raw.githubusercontent.com/jotoh98/lambdock/main/compose.yaml
podman-compose up -d
```

Open <http://localhost:8000/__/>.

See [docs/deploy-podman.md](docs/deploy-podman.md) for auto-start, updates and backups.

### From source

```bash
git clone https://github.com/jotoh98/lambdock.git
cd lambdock
deno task dev
```

Deno 2.4 or later is necessary.

The first start writes three example functions into `./data`.

## How the URLs work

The first path segment selects the function. The rest goes to the routes of that function.

```
http://localhost:8000/hello/ada
                     └───┘ └─┘
                     name  path inside the function
```

| Path          | Goes to                       |
| ------------- | ----------------------------- |
| `/__/`        | the editor                    |
| `/__/api/...` | the admin API                 |
| `/hello`      | function `hello`, path `/`    |
| `/hello/ada`  | function `hello`, path `/ada` |
| `/todos/42`   | function `todos`, path `/42`  |

A function name must start with a letter or a digit. The editor uses the prefix `__`. Therefore a
function can never take the URL of the editor, and two functions can never take the same URL.

## Write a function

```ts
import type { Ctx, FnConfig } from "../../lambdock.ts";

export const config: FnConfig = {
  description: "Shows one user",
  routes: [
    { method: "GET", path: "/" },
    { method: "GET", path: "/:id" },
    { method: "POST", path: "/:id/avatar" },
  ],
  timeoutMs: 30000,
};

export default async function handler(req: Request, ctx: Ctx) {
  ctx.params.id; // path parameter
  ctx.url.searchParams.get("q"); // query string
  ctx.env.API_KEY; // shared environment store
  await ctx.kv.set("last", Date.now()); // storage that stays after a reboot
  console.log("hello"); // shows in the Logs tab

  return { id: ctx.params.id }; // an object becomes JSON
}
```

If you give no `config`, the function receives every method on every sub-path.

**Return values**

| You return        | The client gets          |
| ----------------- | ------------------------ |
| `Response`        | that response, unchanged |
| `string`          | 200, `text/plain`        |
| `null` or nothing | 204                      |
| anything else     | 200, `application/json`  |

More detail: [docs/writing-functions.md](docs/writing-functions.md).

## Path parameters

Patterns use the [`URLPattern`](https://developer.mozilla.org/docs/Web/API/URLPattern) syntax, the
same format as Express and many routers.

| Pattern                   | Matches          | `ctx.params`              |
| ------------------------- | ---------------- | ------------------------- |
| `/:id`                    | `/42`            | `{ id: "42" }`            |
| `/:name?`                 | `/` and `/ada`   | `{}` or `{ name: "ada" }` |
| `/users/:id/posts/:post?` | `/users/7/posts` | `{ id: "7" }`             |
| `/files/*`                | `/files/a/b.txt` | `{ "0": "a/b.txt" }`      |

Routes are tried in the order of the `routes` array. The first match wins.

## The editor

Open `/__/` .

- **Routes** — the live URLs of the function. Each one is a link.
- **Test** — send a request with a method, a path, headers and a body.
- **Logs** — `console.log` and request lines, streamed live.
- **Problems** — the output of `deno check` and module load errors.
- **Env** — shared variables, available as `ctx.env`.

`Cmd`/`Ctrl` + `S` saves. A save reloads the function immediately.

You can also edit the files with your own editor. The server sees the change and reloads the
function.

## Data on disk

```
data/
├── functions/
│   └── hello/
│       ├── handler.ts     your code
│       └── meta.json      name, enabled, timestamps
├── env.json               shared environment variables
├── kv.sqlite              ctx.kv data of all functions
└── lambdock.ts            the type contract (written at each start)
```

Copy this directory to make a backup. Writes go through a temporary file and a rename, so a crash
cannot leave a half-written file.

## Configuration

| Variable              | Default   | Function                              |
| --------------------- | --------- | ------------------------------------- |
| `LAMBDOCK_DATA`       | `./data`  | Directory for functions and data      |
| `LAMBDOCK_HOST`       | `0.0.0.0` | Listen address                        |
| `LAMBDOCK_PORT`       | `8000`    | Listen port                           |
| `LAMBDOCK_TIMEOUT_MS` | `30000`   | Default timeout of a function         |
| `LAMBDOCK_LOG_BUFFER` | `300`     | Log lines kept per function           |
| `LAMBDOCK_TYPECHECK`  | `1`       | Set to `0` to switch off `deno check` |

## Tasks

```bash
deno task dev            # start, and restart when the server code changes
deno task start          # start
deno task test           # run the tests
deno task check          # type check
deno task lint           # lint
deno task fmt            # format
deno task build:editor   # rebuild ui/vendor/editor.js
```

## Limits

Read these before you put lambdock on a public network.

- **There is no authentication.** Anybody who can open the port can change your code. Keep lambdock
  on a private network, or put a proxy with a password in front of it.
- **Functions are not isolated from each other.** They run in the server process and share its
  permissions. Run only code that you trust.
- **A timeout ends the response, not the code.** An endless loop continues until you restart the
  server.
- **Each save keeps the old module in memory.** This is a property of the Deno module cache. Restart
  the server after very many saves.

See [docs/architecture.md](docs/architecture.md) for the reasons behind these.

## License

MIT
