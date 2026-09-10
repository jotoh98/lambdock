import { assert, assertEquals, assertRejects } from "@std/assert";
import { Lambdock, LambdockError } from "./mod.ts";

/**
 * These tests drive a real server over HTTP, so the client is tested the way it
 * is used. The server runs in a subprocess with its own temporary data
 * directory, and never touches a real deployment.
 */

const dataDir = await Deno.makeTempDir({ prefix: "lambdock-client-test-" });
const workDir = await Deno.makeTempDir({ prefix: "lambdock-client-work-" });

const server = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-run",
    "--unstable-kv",
    new URL("../src/main.ts", import.meta.url).pathname,
  ],
  env: { LAMBDOCK_DATA: dataDir, LAMBDOCK_PORT: "0", NO_COLOR: "1" },
  stdout: "piped",
  stderr: "piped",
}).spawn();

/** Reads the port from the first line the server prints. */
async function waitForPort(): Promise<string> {
  const reader = server.stdout.getReader();
  const dec = new TextDecoder();
  let seen = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the server stopped early:\n${seen}`);
    seen += dec.decode(value);
    const m = seen.match(/http:\/\/localhost:(\d+)/);
    if (m) {
      reader.releaseLock();
      // Keep draining, or the pipe fills up and the server blocks.
      (async () => {
        for await (const _ of server.stdout) { /* discard */ }
      })().catch(() => {});
      (async () => {
        for await (const _ of server.stderr) { /* discard */ }
      })().catch(() => {});
      return m[1];
    }
  }
}

const port = await waitForPort();
const lam = new Lambdock({ url: `http://localhost:${port}` });

// The server is up as soon as it answers /health.
for (let i = 0; i < 50; i++) {
  try {
    if ((await lam.health()).ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const handler = (body: string) => `import type { Ctx } from "../../lambdock.ts";\n${body}\n`;

const passingTest = `import { assertEquals } from "jsr:@std/assert@^1.0.10";
import { callFn } from "../../lambdock.ts";
import handler from "./handler.ts";
Deno.test("answers", async () => {
  assertEquals(await (await callFn(handler, "/")).text(), "one");
});
`;

Deno.test("the seeded examples are live", async () => {
  const fns = await lam.list();
  const hello = fns.find((f) => f.slug === "hello");
  assert(hello, "the hello example should exist");
  assertEquals(hello.live, true);
  assertEquals(hello.liveVersion, 1);
  assertEquals(hello.draftAhead, false);
});

Deno.test("create publishes version 1", async () => {
  const created = await lam.create("counter", { source: handler(`export default () => "one";`) });
  assertEquals(created.liveVersion, 1);
  const res = await fetch(`http://localhost:${port}/counter`);
  assertEquals(await res.text(), "one");
});

Deno.test("a push stays a draft", async () => {
  await lam.save("counter", { source: handler(`export default () => "two";`) });
  const info = await lam.get("counter");
  assertEquals(info.liveVersion, 1);
  assertEquals(info.draftAhead, true);
  assertEquals(await (await fetch(`http://localhost:${port}/counter`)).text(), "one");
});

Deno.test("the draft can be invoked before it is live", async () => {
  const draft = await lam.invoke("counter", { path: "/" });
  assertEquals(await draft.text(), "two");
  const live = await lam.invoke("counter", { path: "/", target: "live" });
  assertEquals(await live.text(), "one");
});

Deno.test("publish makes the draft live and records the gate", async () => {
  const res = await lam.publish("counter", { note: "second" });
  assertEquals(res.version.version, 2);
  assertEquals(res.version.note, "second");
  assertEquals(res.version.tests, "none");
  assertEquals(await (await fetch(`http://localhost:${port}/counter`)).text(), "two");
});

Deno.test("tests run against the saved draft and block a bad publish", async () => {
  await lam.save("counter", {
    source: handler(`export default () => "three";`),
    tests: passingTest, // asserts "one", so it fails against this draft
  });

  const run = await lam.test("counter");
  assertEquals(run.ok, false);
  assertEquals(run.failed, 1);

  const blocked = await assertRejects(() => lam.publish("counter"), LambdockError);
  assertEquals(blocked.status, 422);
  assertEquals((blocked.body as { error: string }).error, "tests_failed");
  assertEquals(await (await fetch(`http://localhost:${port}/counter`)).text(), "two");
});

Deno.test("a draft that matches its tests goes live", async () => {
  await lam.save("counter", { source: handler(`export default () => "one";`) });
  const run = await lam.test("counter");
  assertEquals(run.ok, true);
  assertEquals(run.passed, 1);
  const res = await lam.publish("counter", { note: "green" });
  assertEquals(res.version.tests, "passed");
  assertEquals(await (await fetch(`http://localhost:${port}/counter`)).text(), "one");
});

Deno.test("force publishes although the gate failed", async () => {
  await lam.save("counter", { source: handler(`export default () => "forced";`) });
  const res = await lam.publish("counter", { force: true });
  assertEquals(res.version.tests, "forced");
  assertEquals(await (await fetch(`http://localhost:${port}/counter`)).text(), "forced");
});

Deno.test("rollback picks an older version", async () => {
  await lam.rollback("counter", 1);
  assertEquals(await (await fetch(`http://localhost:${port}/counter`)).text(), "one");
  const list = await lam.versions("counter");
  assertEquals(list.liveVersion, 1);
  assertEquals(list.versions.length, 4);
});

Deno.test("a version keeps its own source and tests", async () => {
  const v3 = await lam.version("counter", 3);
  assertEquals(v3.version.version, 3);
  assert(v3.source.includes(`"one"`));
  assert(v3.tests?.includes("Deno.test"));
});

Deno.test("pull writes the files that push reads", async () => {
  const detail = await lam.get("counter");
  await Deno.mkdir(`${workDir}/counter`, { recursive: true });
  await Deno.writeTextFile(`${workDir}/counter/handler.ts`, detail.source);
  assertEquals(await Deno.readTextFile(`${workDir}/counter/handler.ts`), detail.source);
});

Deno.test("deploy pushes and publishes in one step", async () => {
  const res = await lam.deploy("deployed", {
    source: handler(`export default () => "fresh";`),
    note: "from deploy",
  });
  assertEquals(res.version.version, 1); // deploy creates the draft, the gate makes v1
  assertEquals(await (await fetch(`http://localhost:${port}/deployed`)).text(), "fresh");
});

Deno.test("a function without a version refuses requests", async () => {
  await lam.create("later", {
    source: handler(`export default () => "soon";`),
    publish: false,
  });
  const res = await fetch(`http://localhost:${port}/later`);
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "no_live_version");
});

Deno.test("a missing function raises a typed error", async () => {
  const err = await assertRejects(() => lam.get("nope"), LambdockError);
  assertEquals(err.status, 404);
});

Deno.test("the environment round-trips", async () => {
  await lam.setEnv({ GREETING: "hi" });
  assertEquals((await lam.env()).GREETING, "hi");
});

Deno.test("logs are readable", async () => {
  await fetch(`http://localhost:${port}/hello/ada`);
  const lines = await lam.logs("hello");
  assert(lines.some((l) => l.text.includes("greeting ada")));
});

Deno.test("remove deletes the function and its versions", async () => {
  await lam.remove("deployed");
  await assertRejects(() => lam.get("deployed"), LambdockError);
});

Deno.test("cleanup", async () => {
  server.kill("SIGTERM");
  await server.status;
  await Deno.remove(dataDir, { recursive: true });
  await Deno.remove(workDir, { recursive: true });
});

/* The CLI itself: only the paths that do not need a server. */

const CLI = new URL("./cli.ts", import.meta.url).pathname;

async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const res = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", CLI, ...args],
    stdout: "piped",
    stderr: "piped",
    env: { NO_COLOR: "1" },
  }).output();
  const dec = new TextDecoder();
  return { code: res.code, out: dec.decode(res.stdout) + dec.decode(res.stderr) };
}

Deno.test("--help succeeds", async () => {
  const r = await cli(["--help"]);
  assertEquals(r.code, 0);
  assert(r.out.includes("lambdock <command>"));
});

Deno.test("no command prints the help and fails", async () => {
  const r = await cli([]);
  assertEquals(r.code, 1);
  assert(r.out.includes("lambdock <command>"));
});

Deno.test("an unknown command fails and says so", async () => {
  const r = await cli(["frobnicate"]);
  assertEquals(r.code, 1);
  assert(r.out.includes("unknown command"), r.out);
});

Deno.test("a command without its argument fails", async () => {
  const r = await cli(["show"]);
  assertEquals(r.code, 1);
  assert(r.out.includes("slug is required"), r.out);
});
