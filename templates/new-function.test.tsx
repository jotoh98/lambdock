// deno-lint-ignore-file no-import-prefix
// The full specifier is deliberate: `deno test` runs this file inside
// data/functions/<slug>/ with --no-config, where no import map exists.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.10";
import { callFn } from "../../lambdock.ts";
import handler from "./handler.tsx";

// These tests run against the draft, before you create a version.
// `callFn` calls the handler the way the server does and gives you a Response.

Deno.test("the root greets the world", async () => {
  const res = await callFn(handler, "/");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  assertStringIncludes(await res.text(), "<h1>Hello world</h1>");
});

Deno.test("a path parameter is escaped", async () => {
  const res = await callFn(handler, "/x", { params: { name: "<b>" } });
  assertStringIncludes(await res.text(), "<h1>Hello &lt;b&gt;</h1>");
});
