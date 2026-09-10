#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write
/**
 * Compiles the CLI into self-contained binaries.
 * A binary carries the Deno runtime and every module, so the machine that runs
 * it needs no Deno, no import map and no package manager.
 *
 *   deno run -A scripts/build.ts            the host target
 *   deno run -A scripts/build.ts --all      every target below
 *   deno run -A scripts/build.ts x86_64-unknown-linux-gnu
 */

const TARGETS = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
] as const;

const PERMISSIONS = ["--allow-net", "--allow-read", "--allow-write", "--allow-env"];

const args = Deno.args;
const targets = args.includes("--all") ? TARGETS : args.filter((a) => !a.startsWith("-"));

const root = new URL("../", import.meta.url).pathname;
await Deno.mkdir(`${root}dist`, { recursive: true });

async function build(target?: string) {
  const name = target ?? Deno.build.target;
  const ext = name.includes("windows") ? ".exe" : "";
  const out = `${root}dist/lambdock-${name}${ext}`;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "compile",
      ...PERMISSIONS,
      ...(target ? ["--target", target] : []),
      "--output",
      out,
      `${root}cli.ts`,
    ],
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`compile failed for ${name}`);
  const size = (await Deno.stat(out)).size;
  console.log(`${out}  ${(size / 1e6).toFixed(1)} MB`);
}

if (targets.length === 0) await build();
else for (const t of targets) await build(t);
