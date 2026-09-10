// deno-lint-ignore-file no-import-prefix
// The full specifier is deliberate: `deno test` runs this file inside
// data/functions/<slug>/ with --no-config, where no import map exists.
import { assertEquals } from "jsr:@std/assert@^1.0.10";
import { callFn } from "../../lambdock.ts";
import handler from "./handler.ts";

Deno.test("the root greets the world", async () => {
  const res = await callFn(handler, "/");
  assertEquals((await res.json()).hello, "world");
});

Deno.test("a name in the path is used", async () => {
  const res = await callFn(handler, "/ada", { params: { name: "ada" } });
  assertEquals((await res.json()).hello, "ada");
});
