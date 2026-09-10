// deno-lint-ignore-file no-import-prefix
// The full specifier is deliberate: `deno test` runs this file inside
// data/functions/<slug>/ with --no-config, where no import map exists.
import { assertEquals } from "jsr:@std/assert@^1.0.10";
import { callFn, memoryKv } from "../../lambdock.ts";
import handler from "./handler.ts";

const post = (body: unknown) =>
  new Request("http://localhost/todos", { method: "POST", body: JSON.stringify(body) });

Deno.test("an empty store lists nothing", async () => {
  const res = await callFn(handler, "/", { path: "/" });
  assertEquals(await res.json(), []);
});

Deno.test("a todo is created and read back", async () => {
  // One store for both calls, so the second call sees what the first wrote.
  const kv = memoryKv();
  const created = await callFn(handler, post({ title: "buy milk" }), { kv, path: "/" });
  assertEquals(created.status, 201);
  const todo = await created.json();

  const read = await callFn(handler, `/${todo.id}`, { kv, params: { id: todo.id } });
  assertEquals((await read.json()).title, "buy milk");
});

Deno.test("a todo without a title is refused", async () => {
  const res = await callFn(handler, post({}), { path: "/" });
  assertEquals(res.status, 400);
});
