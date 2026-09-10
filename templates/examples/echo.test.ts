// deno-lint-ignore-file no-import-prefix
// The full specifier is deliberate: `deno test` runs this file inside
// data/functions/<slug>/ with --no-config, where no import map exists.
import { assertEquals } from "jsr:@std/assert@^1.0.10";
import { callFn } from "../../lambdock.ts";
import handler from "./handler.ts";

Deno.test("the request is reflected", async () => {
  const res = await callFn(
    handler,
    new Request("http://localhost/echo/a/b?x=1", {
      method: "POST",
      body: JSON.stringify({ hi: true }),
    }),
    { path: "/a/b" },
  );
  const body = await res.json();
  assertEquals(body.method, "POST");
  assertEquals(body.path, "/a/b");
  assertEquals(body.query, { x: "1" });
  assertEquals(body.body, { hi: true });
});
