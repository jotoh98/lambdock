# @lambdock/client

Drive a [lambdock](../README.md) server from your own machine: push a draft, run its tests, publish
a version, roll one back.

A save is a draft. Only `publish` changes what the server answers with.

## Install

The package has no runtime dependency. It uses only the Deno standard runtime, so it works from a
single binary, from a checkout, or straight from a URL — with no import map and no package manager.

**A binary** — the machine that runs it needs nothing at all, not even Deno:

```bash
deno task compile                # dist/lambdock, about 67 MB
./dist/lambdock ls
```

Cross-compile for a server:

```bash
deno run -A scripts/build.ts --all                       # five targets
deno run -A scripts/build.ts x86_64-unknown-linux-gnu    # only one
```

**On a machine that has Deno:**

```bash
deno task install                # puts `lambdock` on your PATH
deno run --allow-net --allow-read --allow-write --allow-env cli.ts ls   # or run it in place
```

Point it at your server:

```bash
export LAMBDOCK_URL=http://192.168.2.93:8000
```

`--url` overrides `LAMBDOCK_URL`. The default is `http://localhost:8000`.

## The usual round trip

```bash
lambdock pull hello           # hello/handler.ts and hello/handler.test.ts
$EDITOR hello/handler.ts
lambdock push hello           # save the draft. The live route does not move
lambdock test hello           # run the tests against the saved draft
lambdock invoke hello /ada    # run the draft and print the response
lambdock publish hello        # gate, then make it live
```

`deploy` is `push` and `publish` in one call:

```bash
lambdock deploy hello --note "greeting in German"
```

When something goes wrong:

```bash
lambdock versions hello       # the history, and which version is live
lambdock rollback hello 2     # make version 2 live again
lambdock logs hello --follow
```

## Commands

| Command                  | What it does                                            |
| ------------------------ | ------------------------------------------------------- |
| `ls`                     | Every function, its routes and the version that is live |
| `show <slug>`            | The same plus the version history and the draft state   |
| `versions <slug>`        | Version history                                         |
| `pull <slug>`            | Write the draft (or `--version n`) into `<slug>/`       |
| `new <slug>`             | Create a function. Version 1 goes live at once          |
| `push <slug>`            | Save the draft from `<slug>/handler.ts`                 |
| `check <slug>`           | `deno check`                                            |
| `test <slug>`            | `deno test` against the saved draft                     |
| `publish <slug>`         | Gate, then create a version and make it live            |
| `deploy <slug>`          | `push`, then `publish`                                  |
| `rollback <slug> <n>`    | Make a version that exists live again                   |
| `invoke <slug> [path]`   | Run the draft, the live version or one version          |
| `logs <slug> [--follow]` | Log lines                                               |
| `enable` / `disable`     | Switch a function off without deleting it               |
| `rename <slug> <to>`     | Rename, with the versions                               |
| `rm <slug>`              | Delete the function, every version and its stored data  |
| `env [KEY=value]`        | Read or set the shared environment                      |

Flags: `--url`, `--file`, `--tests`, `--dir`, `--target`, `--version`, `--note`, `--force`,
`--json`, `--yes`, `-X`, `-d`, `-H`, `--follow`.

`push` and `deploy` look for the source in `<slug>/handler.ts`, then `<slug>.ts`, then `handler.ts`.
A `handler.test.ts` next to it is sent as well. `--file` overrides the search.

`--target` selects what `invoke`, `check` and `test` run: `draft` (the default), `live`, or a
version number.

A blocked publish exits non-zero and prints the gate output. `--force` publishes in spite of it, and
the version records `tests: "forced"`.

## As a library

```ts
import { Lambdock, LambdockError } from "@lambdock/client";

const lam = new Lambdock({ url: "http://192.168.2.93:8000" });

await lam.save("db", { source, tests });
const run = await lam.test("db");
if (!run.ok) throw new Error(run.output);
const version = await lam.publish("db", { note: "transitous" });
console.log(`live on v${version.version.version}`);
```

`publish` throws a `LambdockError` with `status: 422` when the gate refuses it. Its `body` holds the
`check` and `tests` results.

Every method mirrors one admin endpoint: `health`, `state`, `list`, `get`, `versions`, `version`,
`create`, `save`, `remove`, `rename`, `setEnabled`, `check`, `test`, `publish`, `rollback`,
`invoke`, `deploy`, `logs`, `clearLogs`, `streamLogs`, `env`, `setEnv`.

`invoke` gives you the real `Response` of the handler, so you can read its status, headers and body.

## No dependencies

`mod.ts`, `cli.ts` and `flags.ts` import nothing outside the Deno runtime. The argument parser and
the ANSI helpers are in `flags.ts`, about 90 lines, with their own tests. `@std/assert` appears in
`deno.json` for the tests only; it is not in the compiled binary.

That is what makes `deno compile` produce a binary you can copy to a server, and what lets

```bash
deno run --allow-net --allow-env https://raw.githubusercontent.com/jotoh98/lambdock/main/client/cli.ts ls
```

work with no checkout.

## Tests

```bash
deno task test          # the client against a real server in a subprocess
```

They start the server with a temporary data directory and drive it over HTTP, so the whole path is
covered: HTTP, the admin API, the gate and the version files on disk.
