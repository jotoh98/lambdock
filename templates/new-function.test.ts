// deno-lint-ignore-file no-import-prefix
// The full specifier is deliberate: `deno test` runs this file inside
// data/functions/<slug>/ with --no-config, where no import map exists.
import { assertEquals } from "jsr:@std/assert@^1.0.10";
import { callFn } from "../../lambdock.ts";
import handler from "./handler.ts";

// These tests run against the draft, before you create a version.
// `callFn` calls the handler the way the server does and gives you a Response.

Deno.test("the root greets the world", async () => {
  const res = await callFn(handler, "/");
  assertEquals(res.status, 200);
  assertEquals((await res.json()).hello, "world");
});

Deno.test("a path parameter is used", async () => {
  const res = await callFn(handler, "/ada", { params: { name: "ada" } });
  assertEquals((await res.json()).hello, "ada");
});
