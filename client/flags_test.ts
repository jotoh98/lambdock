import { assertEquals, assertThrows } from "@std/assert";
import { parseFlags } from "./flags.ts";

const spec = {
  string: ["url", "note"],
  boolean: ["force", "help"],
  collect: ["header"],
  alias: { h: "help", H: "header" },
} as const;

Deno.test("positionals keep their order", () => {
  assertEquals(parseFlags(["publish", "hello"], spec)._, ["publish", "hello"]);
});

Deno.test("a value comes from the next argument or after =", () => {
  assertEquals(parseFlags(["--url", "http://x"], spec).url, "http://x");
  assertEquals(parseFlags(["--url=http://x"], spec).url, "http://x");
});

Deno.test("a boolean flag is true when present and false when absent", () => {
  assertEquals(parseFlags(["--force"], spec).force, true);
  assertEquals(parseFlags([], spec).force, false);
});

Deno.test("a short name resolves to its long name", () => {
  assertEquals(parseFlags(["-h"], spec).help, true);
  assertEquals(parseFlags(["-H", "a: 1"], spec).header, ["a: 1"]);
});

Deno.test("a collected flag gathers every value", () => {
  assertEquals(parseFlags(["-H", "a: 1", "--header", "b: 2"], spec).header, ["a: 1", "b: 2"]);
});

Deno.test("-- stops the parsing", () => {
  assertEquals(parseFlags(["push", "--", "--force"], spec)._, ["push", "--force"]);
  assertEquals(parseFlags(["push", "--", "--force"], spec).force, false);
});

Deno.test("a value that is missing is an error, not a silent true", () => {
  assertThrows(() => parseFlags(["--url"], spec), Error, "needs a value");
});

Deno.test("a note may look like a flag", () => {
  assertEquals(parseFlags(["--note=--force"], spec).note, "--force");
});
