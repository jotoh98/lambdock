// deno-lint-ignore-file no-import-prefix
// The full specifier is deliberate: `deno test` runs this file inside
// data/functions/<slug>/ with --no-config, where no import map exists.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.10";
import { callFn, memoryKv } from "../../lambdock.ts";
import handler from "./handler.tsx";

Deno.test("the page is an HTML document", async () => {
  const res = await callFn(handler, "/");
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await res.text();
  assertEquals(html.startsWith("<!doctype html><html"), true);
  assertStringIncludes(html, "<h1>Hello world</h1>");
});

Deno.test("the counter goes up and a name is escaped", async () => {
  const kv = memoryKv();
  await callFn(handler, "/", { kv });
  const html = await (await callFn(handler, "/?name=<ada>", { kv })).text();
  assertStringIncludes(html, "2 visits");
  assertStringIncludes(html, "Hello &lt;ada&gt;");
});
