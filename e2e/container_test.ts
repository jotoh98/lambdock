import { assert, assertEquals, assertRejects } from "@std/assert";
import { Lambdock, LambdockError } from "../client/mod.ts";
import { type Container, startContainer } from "./container.ts";

/**
 * End to end: a real image, a real container, the real client over HTTP.
 * The unit tests run the server in this process; these do not, so they also
 * cover the Dockerfile, the module cache in the image and the port mapping.
 */

let box: Container;
try {
  box = await startContainer();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  throw e;
}

const lam = new Lambdock({ url: box.url });
const handler = (body: string) => `import type { Ctx } from "../../lambdock.ts";\n${body}\n`;

const testFor = (expected: string) =>
  `import { assertEquals } from "jsr:@std/assert@^1.0.10";
import { callFn } from "../../lambdock.ts";
import handler from "./handler.ts";
Deno.test("answers ${expected}", async () => {
  assertEquals(await (await callFn(handler, "/")).text(), "${expected}");
});
`;

const body = async (path: string) => (await fetch(`${box.url}${path}`)).text();

Deno.test("the container serves the editor and the admin API", async () => {
  assertEquals((await lam.health()).ok, true);
  const editor = await fetch(`${box.url}/__/`);
  assertEquals(editor.status, 200);
  assert((await editor.text()).includes("lambdock"));
});

Deno.test("the seeded examples are live on version 1", async () => {
  const fns = await lam.list();
  assertEquals(fns.map((f) => f.slug).sort(), ["echo", "hello", "todos"]);
  for (const f of fns) {
    assertEquals(f.live, true, `${f.slug} should be live`);
    assertEquals(f.liveVersion, 1);
    assertEquals(f.draftAhead, false);
  }
  assert((await body("/hello/ada")).includes("ada"));
});

Deno.test("a new function answers at once", async () => {
  await lam.create("counter", { source: handler(`export default () => "one";`) });
  assertEquals(await body("/counter"), "one");
});

Deno.test("a save is a draft and the live route does not move", async () => {
  await lam.save("counter", {
    source: handler(`export default () => "two";`),
    tests: testFor("one"),
  });
  const info = await lam.get("counter");
  assertEquals(info.liveVersion, 1);
  assertEquals(info.draftAhead, true);
  assertEquals(await body("/counter"), "one");
});

Deno.test("the draft is reachable only below the admin prefix", async () => {
  assertEquals(await (await lam.invoke("counter", { path: "/" })).text(), "two");
  assertEquals(await (await lam.invoke("counter", { path: "/", target: "live" })).text(), "one");
  // Nothing on the public route serves a draft.
  assertEquals(await body("/counter"), "one");
});

Deno.test("the tests run inside the container and see the draft", async () => {
  const run = await lam.test("counter");
  assertEquals(run.ok, false, run.output);
  assertEquals(run.failed, 1);
  assert(run.output.includes("two"), run.output);
});

Deno.test("a failing gate blocks the version", async () => {
  const err = await assertRejects(() => lam.publish("counter"), LambdockError);
  assertEquals(err.status, 422);
  assertEquals((err.body as { error: string }).error, "tests_failed");
  assertEquals(await body("/counter"), "one");
  assertEquals((await lam.versions("counter")).versions.length, 1);
});

Deno.test("a green gate makes the draft live", async () => {
  await lam.save("counter", { tests: testFor("two") });
  const run = await lam.test("counter");
  assertEquals(run.ok, true, run.output);
  const res = await lam.publish("counter", { note: "two" });
  assertEquals(res.version.version, 2);
  assertEquals(res.version.check, "passed");
  assertEquals(res.version.tests, "passed");
  assertEquals(await body("/counter"), "two");
});

Deno.test("a rollback brings the old code back", async () => {
  await lam.rollback("counter", 1);
  assertEquals(await body("/counter"), "one");
  assertEquals((await lam.versions("counter")).liveVersion, 1);
  await lam.rollback("counter", 2);
  assertEquals(await body("/counter"), "two");
});

Deno.test("a version snapshot is on disk and is not a URL", async () => {
  const ls = await box.exec(["ls", "/data/functions"]);
  assertEquals(ls.code, 0, ls.out);
  assert(ls.out.includes("counter@1"), ls.out);
  assert(ls.out.includes("counter@2"), ls.out);

  const res = await fetch(`${box.url}/counter@1`);
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "no_such_function");
});

Deno.test("an old version keeps its own source", async () => {
  const v1 = await lam.version("counter", 1);
  assert(v1.source.includes(`"one"`));
  const v2 = await lam.version("counter", 2);
  assert(v2.source.includes(`"two"`));
  assert(v2.tests?.includes("Deno.test"));
});

Deno.test("the gate needs no network: the test dependency is in the image", async () => {
  // --cached-only fails if the image did not cache jsr:@std/assert.
  const res = await box.exec([
    "deno",
    "test",
    "--cached-only",
    "--no-lock",
    "--no-config",
    "--allow-all",
    "--quiet",
    "/data/functions/counter/handler.test.ts",
  ]);
  assertEquals(res.code, 0, res.out);
});

Deno.test("a function without a version refuses requests", async () => {
  await lam.create("later", { source: handler(`export default () => "soon";`), publish: false });
  const res = await fetch(`${box.url}/later`);
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "no_live_version");
});

Deno.test("the key-value store survives between requests", async () => {
  await lam.deploy("hits", {
    source: handler(`export default async (_r: Request, c: Ctx) => {
  const n = (await c.kv.get<number>("n") ?? 0) + 1;
  await c.kv.set("n", n);
  return { n };
};`),
  });
  assertEquals(JSON.parse(await body("/hits")).n, 1);
  assertEquals(JSON.parse(await body("/hits")).n, 2);
});

Deno.test("delete removes the function and every snapshot", async () => {
  await lam.remove("counter");
  const ls = await box.exec(["ls", "/data/functions"]);
  assertEquals(ls.out.includes("counter"), false, ls.out);
  assertEquals((await fetch(`${box.url}/counter`)).status, 404);
});

Deno.test("cleanup", async () => {
  await box.stop();
});
