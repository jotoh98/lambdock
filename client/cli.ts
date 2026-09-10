#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
/**
 * Command line for a lambdock server.
 * Install it as `lambdock`: deno task install
 */
import { bold, dim, green, parseFlags, red, yellow } from "./flags.ts";
import {
  type FnSummary,
  Lambdock,
  LambdockError,
  type Target,
  type TestResult,
  type VersionMeta,
} from "./mod.ts";

const HELP = `lambdock - drive a lambdock server

  lambdock <command> [arguments] [flags]

Reading
  ls                          List functions, with the live version of each
  show <slug>                 Routes, versions and the state of the draft
  versions <slug>             Version history
  pull <slug>                 Write the draft to <slug>/handler.ts
  logs <slug> [--follow]      Recent log lines
  env                         Show the shared environment

Writing
  new <slug>                  Create a function. Version 1 goes live at once
  push <slug>                 Save the draft. The live route does not change
  publish <slug>              Create a version from the draft and make it live
  deploy <slug>               push, then publish
  rollback <slug> <version>   Make a version that exists live again
  rename <slug> <to>
  enable <slug> | disable <slug>
  rm <slug>
  env --set KEY=value         Replace one variable

Trying it out
  check <slug>                Run deno check
  test <slug>                 Run the tests
  invoke <slug> [path]        Run the function and print the response

Flags
  --url <url>       Server. Default: $LAMBDOCK_URL or http://localhost:8000
  --file <path>     Source for new, push and deploy
  --tests <path>    Test file for new, push and deploy
  --dir <path>      Target directory for pull. Default: <slug>
  --target <t>      draft (default), live, or a version number
  --version <n>     Version for pull and check and test
  --note <text>     Note stored with a version
  --force           Publish although the gate failed
  --json            Print the raw response
  --yes             Do not ask before rm
  -X, --method <m>  Method for invoke
  -d, --data <body> Body for invoke
  -H, --header <h>  Header for invoke, repeatable
  --follow          Keep the log stream open
  -h, --help

A save is a draft. Only "publish" changes what the server answers with.`;

let flags: ReturnType<typeof parseFlags>;
try {
  flags = parseFlags(Deno.args, {
    string: ["url", "file", "tests", "dir", "target", "version", "note", "method", "data"],
    boolean: ["json", "force", "follow", "help", "yes"],
    collect: ["header"],
    alias: { h: "help", X: "method", d: "data", H: "header", v: "version" },
  });
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  Deno.exit(1);
}

const [command, ...rest] = flags._;
const str = (name: string) => flags[name] as string | undefined;
const bool = (name: string) => flags[name] === true;

if (flags.help || !command) {
  console.log(HELP);
  Deno.exit(command ? 0 : 1);
}

const lam = new Lambdock({ url: str("url") });

function die(message: string): never {
  console.error(red("error: ") + message);
  Deno.exit(1);
}

function need(index: number, name: string): string {
  const value = rest[index];
  if (!value) die(`${name} is required. Try: lambdock --help`);
  return value;
}

function out(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function target(): Target {
  const raw = str("target") ?? str("version");
  if (!raw) return "draft";
  if (raw === "draft" || raw === "live") return raw;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) die(`bad target: ${raw}`);
  return n;
}

/** Finds the local source file: --file, else the usual places. */
async function sourceFile(slug: string): Promise<string> {
  const given = str("file");
  if (given) return given;
  for (const p of [`${slug}/handler.ts`, `${slug}.ts`, "handler.ts"]) {
    try {
      await Deno.stat(p);
      return p;
    } catch { /* try the next one */ }
  }
  die(`no source file found. Pass --file, or put it in ${slug}/handler.ts`);
}

/** The test file that belongs to a source file, when it exists. */
async function testFile(source: string): Promise<string | undefined> {
  if (str("tests")) return str("tests");
  const guess = source.replace(/\.ts$/, ".test.ts");
  try {
    await Deno.stat(guess);
    return guess;
  } catch {
    return undefined;
  }
}

function liveLabel(f: FnSummary): string {
  if (!f.live) return red("no version");
  const live = `v${f.liveVersion}`;
  return f.draftAhead ? `${green(live)} ${yellow("draft ahead")}` : green(live);
}

function printFn(f: FnSummary) {
  const state = f.enabled ? "" : dim(" disabled");
  console.log(`${bold(f.slug.padEnd(20))} ${liveLabel(f)}${state}`);
  if (f.description) console.log(`  ${dim(f.description)}`);
  for (const r of f.routes) console.log(`  ${dim(r.method.padEnd(6))} ${r.url}`);
  if (f.error) console.log(red(`  load error: ${f.error.split("\n")[0]}`));
}

function printVersion(v: VersionMeta, live: boolean) {
  const mark = live ? green(" <- live") : "";
  const gate = `check:${v.check} tests:${v.tests}`;
  console.log(
    `  v${String(v.version).padEnd(4)} ${v.createdAt.slice(0, 19).replace("T", " ")}  ${
      dim(gate)
    }${mark}`,
  );
  if (v.note) console.log(`         ${v.note}`);
}

/** Prints a test or check result and returns its exit code. */
function report(name: string, r: TestResult | { ok: boolean; output: string; skipped?: string }) {
  if (r.skipped) {
    console.log(yellow(`${name} skipped: ${r.skipped}`));
    return 0;
  }
  if (r.output) console.log(r.output);
  if (r.ok) {
    const counts = "passed" in r ? ` (${r.passed} passed)` : "";
    console.log(green(`${name} ok${counts}`));
    return 0;
  }
  console.log(red(`${name} failed`));
  return 1;
}

async function run(): Promise<number> {
  switch (command) {
    case "ls": {
      const fns = await lam.list();
      if (flags.json) return out(fns), 0;
      if (fns.length === 0) console.log(dim("no functions"));
      for (const f of fns) printFn(f);
      return 0;
    }

    case "show": {
      const slug = need(0, "slug");
      const f = await lam.get(slug);
      if (flags.json) return out(f), 0;
      printFn(f);
      console.log(`  ${dim("tests")}  ${f.tests ? "yes" : dim("none")}`);
      console.log(`  ${dim("draft")}  ${f.source.split("\n").length} lines, saved ${f.updatedAt}`);
      if (f.versionList.length) {
        console.log("");
        console.log(bold("versions"));
        for (const v of f.versionList) printVersion(v, v.version === f.liveVersion);
      }
      return 0;
    }

    case "versions": {
      const slug = need(0, "slug");
      const list = await lam.versions(slug);
      if (flags.json) return out(list), 0;
      if (list.versions.length === 0) console.log(dim("no versions"));
      for (const v of list.versions) printVersion(v, v.version === list.liveVersion);
      if (list.draftAhead) console.log(yellow("the draft differs from the live version"));
      return 0;
    }

    case "pull": {
      const slug = need(0, "slug");
      const dir = str("dir") ?? slug;
      const t = target();
      const [source, tests] = t === "draft"
        ? await lam.get(slug).then((f) => [f.source, f.tests] as const)
        : await lam.versions(slug)
          .then((l) => (t === "live" ? l.liveVersion! : t))
          .then((n) => lam.version(slug, n))
          .then((v) => [v.source, v.tests] as const);
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(`${dir}/handler.ts`, source);
      console.log(`${dir}/handler.ts`);
      if (tests) {
        await Deno.writeTextFile(`${dir}/handler.test.ts`, tests);
        console.log(`${dir}/handler.test.ts`);
      }
      return 0;
    }

    case "new": {
      const slug = need(0, "slug");
      const file = str("file");
      const source = file ? await Deno.readTextFile(file) : undefined;
      const testsPath = file ? await testFile(file) : str("tests");
      const created = await lam.create(slug, {
        source,
        tests: testsPath ? await Deno.readTextFile(testsPath) : undefined,
      });
      if (flags.json) return out(created), 0;
      printFn(created);
      return report("check", created.check);
    }

    case "push": {
      const slug = need(0, "slug");
      const file = await sourceFile(slug);
      const testsPath = await testFile(file);
      const saved = await lam.save(slug, {
        source: await Deno.readTextFile(file),
        tests: testsPath ? await Deno.readTextFile(testsPath) : undefined,
      });
      if (flags.json) return out(saved), 0;
      console.log(`saved draft of ${bold(slug)} from ${file}`);
      if (testsPath) console.log(`tests from ${testsPath}`);
      console.log(dim(`live is still ${saved.live ? `v${saved.liveVersion}` : "unpublished"}`));
      return report("check", saved.check);
    }

    case "check": {
      const slug = need(0, "slug");
      return report("check", await lam.check(slug, target()));
    }

    case "test": {
      const slug = need(0, "slug");
      return report("tests", await lam.test(slug, target()));
    }

    case "publish": {
      const slug = need(0, "slug");
      try {
        const res = await lam.publish(slug, { note: str("note"), force: bool("force") });
        if (flags.json) return out(res), 0;
        report("check", res.check);
        report("tests", res.tests);
        console.log(green(`${slug} is live on v${res.version.version}`));
        return 0;
      } catch (e) {
        return gateFailure(e);
      }
    }

    case "deploy": {
      const slug = need(0, "slug");
      const file = await sourceFile(slug);
      const testsPath = await testFile(file);
      try {
        const res = await lam.deploy(slug, {
          source: await Deno.readTextFile(file),
          tests: testsPath ? await Deno.readTextFile(testsPath) : undefined,
          note: str("note"),
          force: bool("force"),
        });
        if (flags.json) return out(res), 0;
        console.log(`pushed ${file}${testsPath ? ` and ${testsPath}` : ""}`);
        report("check", res.check);
        report("tests", res.tests);
        console.log(green(`${slug} is live on v${res.version.version}`));
        return 0;
      } catch (e) {
        return gateFailure(e);
      }
    }

    case "rollback": {
      const slug = need(0, "slug");
      const n = Number(need(1, "version"));
      const res = await lam.rollback(slug, n);
      if (flags.json) return out(res), 0;
      console.log(green(`${slug} is live on v${res.liveVersion}`));
      return 0;
    }

    case "invoke": {
      const slug = need(0, "slug");
      const headers: Record<string, string> = {};
      for (const h of (flags.header as string[] | undefined) ?? []) {
        const at = h.indexOf(":");
        if (at === -1) die(`bad header: ${h}`);
        headers[h.slice(0, at).trim()] = h.slice(at + 1).trim();
      }
      const res = await lam.invoke(slug, {
        path: rest[1] ?? "/",
        method: str("method") ?? (str("data") ? "POST" : "GET"),
        headers,
        body: str("data") ?? null,
        target: target(),
      });
      const body = await res.text();
      const line = `${res.status} ${res.headers.get("x-lambdock-target") ?? ""} ${
        res.headers.get("x-lambdock-duration-ms") ?? ""
      }ms`;
      console.error(res.ok ? dim(line) : red(line));
      if (body) console.log(body);
      return res.ok ? 0 : 1;
    }

    case "logs": {
      const slug = need(0, "slug");
      for (const l of await lam.logs(slug)) printLog(l);
      if (!flags.follow) return 0;
      const stop = new AbortController();
      Deno.addSignalListener("SIGINT", () => stop.abort());
      try {
        for await (const l of lam.streamLogs(stop.signal)) {
          if (l.slug === slug) printLog(l);
        }
      } catch { /* the stream ended */ }
      return 0;
    }

    case "enable":
    case "disable": {
      const slug = need(0, "slug");
      const res = await lam.setEnabled(slug, command === "enable");
      console.log(`${slug} is ${res.enabled ? "enabled" : "disabled"}`);
      return 0;
    }

    case "rename": {
      const slug = need(0, "slug");
      const to = need(1, "new name");
      await lam.rename(slug, to);
      console.log(`${slug} -> ${to}`);
      return 0;
    }

    case "rm": {
      const slug = need(0, "slug");
      if (!flags.yes && !confirm(`Delete ${slug} with every version and its stored data?`)) {
        return 1;
      }
      await lam.remove(slug);
      console.log(`${slug} is gone`);
      return 0;
    }

    case "env": {
      const sets = rest.filter((a) => a.includes("="));
      if (sets.length === 0 && !flags.json) {
        const env = await lam.env();
        for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`);
        if (Object.keys(env).length === 0) console.log(dim("empty"));
        return 0;
      }
      if (sets.length === 0) return out(await lam.env()), 0;
      const env = await lam.env();
      for (const pair of sets) {
        const at = pair.indexOf("=");
        env[pair.slice(0, at)] = pair.slice(at + 1);
      }
      const saved = await lam.setEnv(env);
      for (const [k, v] of Object.entries(saved)) console.log(`${k}=${v}`);
      return 0;
    }

    default:
      die(`unknown command: ${command}. Try: lambdock --help`);
  }
}

function printLog(l: { ts: number; level: string; requestId: string; text: string }) {
  const time = new Date(l.ts).toISOString().slice(11, 19);
  const paint = l.level === "error" ? red : l.level === "system" ? dim : (s: string) => s;
  console.log(`${dim(time)} ${dim(l.requestId)} ${paint(l.text)}`);
}

/** A 422 from publish carries the gate output. Show it instead of a bare message. */
function gateFailure(e: unknown): number {
  if (e instanceof LambdockError && e.status === 422) {
    const body = e.body as { error: string; check?: TestResult; tests?: TestResult };
    if (body.check) report("check", body.check);
    if (body.tests) report("tests", body.tests);
    console.error(red(`not published: ${body.error}. Fix it, or publish with --force.`));
    return 1;
  }
  throw e;
}

try {
  Deno.exit(await run());
} catch (e) {
  if (e instanceof LambdockError) die(`${e.message} (HTTP ${e.status})`);
  die(e instanceof Error ? e.message : String(e));
}
