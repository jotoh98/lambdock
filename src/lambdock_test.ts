import { assert, assertEquals } from "@std/assert";

const tmp = await Deno.makeTempDir({ prefix: "lambdock-test-" });
Deno.env.set("LAMBDOCK_DATA", tmp);
Deno.env.set("LAMBDOCK_TYPECHECK", "0");

const { handle } = await import("./main.ts");
const store = await import("./store.ts");
const registry = await import("./registry.ts");
const { closeKv } = await import("./kv.ts");
const logs = await import("./logs.ts");
const { installCrashGuard, slugFromStack } = await import("./guard.ts");

await store.init();

const src = (body: string) => `import type { Ctx, FnConfig } from "../../lambdock.ts";\n${body}\n`;

await store.createFn(
  "greet",
  src(`export const config: FnConfig = {
  routes: [
    { method: "GET", path: "/" },
    { method: "GET", path: "/:name" },
    { method: "POST", path: "/:name/items/*" },
  ],
};
export default (_r: Request, c: Ctx) => ({ params: c.params, path: c.path });`),
);
await store.createFn(
  "catchall",
  src(`export default (r: Request, c: Ctx) => c.path + " " + r.method;`),
);
await store.createFn("broken", `throw new Error("nope");`);
await store.createFn(
  "kvfn",
  src(`export default async (_r: Request, c: Ctx) => {
  await c.kv.set("n", (await c.kv.get<number>("n") ?? 0) + 1);
  return { n: await c.kv.get<number>("n") };
};`),
);
await registry.loadAll();

const req = (path: string, init?: RequestInit) =>
  handle(new Request("http://localhost" + path, init));

Deno.test("slug validation keeps the admin prefix free", () => {
  assertEquals(store.validateSlug("hello"), null);
  assertEquals(store.validateSlug("my-fn-2"), null);
  assert(store.validateSlug("__admin"));
  assert(store.validateSlug("_x"));
  assert(store.validateSlug("Upper"));
  assert(store.validateSlug("has space"));
  assert(store.validateSlug("a/b"));
});

Deno.test("each function is mounted below its own slug", async () => {
  assertEquals(await (await req("/catchall/a/b")).text(), "/a/b GET");
  assertEquals((await (await req("/greet/ada")).json()).params.name, "ada");
});

Deno.test("path parameters use the common :param format", async () => {
  const r = await (await req("/greet/ada")).json();
  assertEquals(r.params, { name: "ada" });
  assertEquals(r.path, "/ada");

  const w = await (await req("/greet/ada/items/a/b", { method: "POST" })).json();
  assertEquals(w.params.name, "ada");
  assertEquals(w.params["0"], "a/b");
});

Deno.test("the mount root and trailing slashes match", async () => {
  assertEquals((await req("/greet")).status, 200);
  assertEquals((await req("/greet/")).status, 200);
  assertEquals((await (await req("/greet/ada/")).json()).params.name, "ada");
});

Deno.test("the method is part of the match", async () => {
  assertEquals((await req("/greet/ada", { method: "DELETE" })).status, 404);
  assertEquals((await req("/catchall/x", { method: "DELETE" })).status, 200);
});

Deno.test("an unknown function gives 404 and lists what exists", async () => {
  const res = await req("/does-not-exist");
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, "no_such_function");
  assert(body.available.includes("/greet"));
});

Deno.test("a module that fails to load gives 500 and does not stop the server", async () => {
  assertEquals((await req("/broken")).status, 500);
  assertEquals((await req("/greet/ada")).status, 200);
});

Deno.test("a disabled function gives 503", async () => {
  await store.setEnabled("catchall", false);
  await registry.load("catchall");
  assertEquals((await req("/catchall/x")).status, 503);
  await store.setEnabled("catchall", true);
  await registry.load("catchall");
  assertEquals((await req("/catchall/x")).status, 200);
});

Deno.test("saving the source hot-reloads the function", async () => {
  await store.writeSource("greet", src(`export default () => "v2";`));
  assertEquals(await (await req("/greet/anything")).text(), "v2");
  await store.writeSource(
    "greet",
    src(`export const config: FnConfig = { routes: [{ method: "GET", path: "/:name" }] };
export default (_r: Request, c: Ctx) => ({ params: c.params, path: c.path });`),
  );
  assertEquals((await (await req("/greet/ada")).json()).params.name, "ada");
});

Deno.test("return values are coerced", async () => {
  await store.createFn(
    "kinds",
    src(`export const config: FnConfig = {
  routes: [{ method: "GET", path: "/:kind" }],
};
export default (_r: Request, c: Ctx) => {
  if (c.params.kind === "text") return "plain";
  if (c.params.kind === "none") return null;
  if (c.params.kind === "res") return new Response("raw", { status: 201 });
  return { json: true };
};`),
  );
  await registry.load("kinds");
  const text = await req("/kinds/text");
  assertEquals(text.headers.get("content-type"), "text/plain; charset=utf-8");
  assertEquals((await req("/kinds/none")).status, 204);
  assertEquals((await req("/kinds/res")).status, 201);
  const json = await req("/kinds/obj");
  assert(json.headers.get("content-type")?.includes("application/json"));
});

Deno.test("responses carry tracing headers", async () => {
  const res = await req("/greet/ada");
  assertEquals(res.headers.get("x-lambdock-function"), "greet");
  assert(res.headers.get("x-lambdock-request-id"));
  assert(res.headers.get("x-lambdock-duration-ms"));
});

Deno.test("the key-value store keeps data per function", async () => {
  assertEquals((await (await req("/kvfn")).json()).n, 1);
  assertEquals((await (await req("/kvfn")).json()).n, 2);
});

Deno.test("the admin prefix serves the API, not a function", async () => {
  const res = await req("/__/api/health");
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
});

Deno.test("the root path redirects to the editor", async () => {
  const res = await req("/");
  assertEquals(res.status, 302);
  assert(res.headers.get("location")?.endsWith("/__/"));
});

Deno.test("a late failure in a function does not stop the server", async () => {
  installCrashGuard();
  await store.createFn(
    "latefail",
    src(`Promise.reject(new Error("boom"));
export default () => "ok";`),
  );
  await registry.load("latefail");
  await new Promise((r) => setTimeout(r, 50)); // let the rejection reach the event loop

  assertEquals(await (await req("/latefail")).text(), "ok");
  assertEquals((await req("/greet/ada")).status, 200);
  assert(logs.recent("latefail").some((l) => l.text.includes("boom")));
});

Deno.test("a stack trace names the function it came from", () => {
  const inside = `at file://${tmp}/functions/latefail/handler.ts?v=1:1:9`;
  assertEquals(slugFromStack(inside), "latefail");
  assertEquals(slugFromStack("at file:///src/main.ts:1:1"), null);
});

Deno.test("cleanup", () => {
  closeKv();
  Deno.removeSync(tmp, { recursive: true });
});
