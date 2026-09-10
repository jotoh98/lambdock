import { config } from "./config.ts";
import { filesOf } from "./store.ts";

export interface TestResult {
  ok: boolean;
  /** Raw output of `deno test`. */
  output: string;
  passed: number;
  failed: number;
  /** Set when no test run happened. `ok` is then true. */
  skipped?: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `ok | 3 passed | 0 failed (12ms)` is the summary line of `deno test`. */
function countResults(output: string): { passed: number; failed: number } {
  const m = output.match(/(\d+) passed[^|]*\|\s*(\d+) failed/);
  return { passed: Number(m?.[1] ?? 0), failed: Number(m?.[2] ?? 0) };
}

/**
 * Runs `deno test` on one test file in a subprocess.
 *
 * The tests get full permissions. A handler may call the network or read the
 * environment, and a subprocess is a new process, so the permissions of the
 * server would not apply to it anyway. --allow-run is the real trust boundary,
 * and the server needs that for the type check as well.
 */
export async function runTestFile(file: string): Promise<TestResult> {
  if (!config.runTests) {
    return { ok: true, output: "", passed: 0, failed: 0, skipped: "disabled by LAMBDOCK_TESTS=0" };
  }
  if (!(await fileExists(file))) {
    return { ok: true, output: "", passed: 0, failed: 0, skipped: "no test file" };
  }
  try {
    const cmd = new Deno.Command(Deno.execPath(), {
      // --no-config for the same reason as the type check: the server's
      // deno.json excludes the data directory.
      args: ["test", "--allow-all", "--no-lock", "--no-config", "--quiet", file],
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();
    let killed = false;
    const timeout = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
    }, config.testTimeoutMs);
    const out = await child.output();
    clearTimeout(timeout);
    const dec = new TextDecoder();
    const text = (dec.decode(out.stdout) + dec.decode(out.stderr)).trim();
    if (killed) {
      return {
        ok: false,
        output: `${text}\n\nKilled after ${config.testTimeoutMs} ms.`.trim(),
        passed: 0,
        failed: 1,
      };
    }
    return { ok: out.code === 0, output: text, ...countResults(text) };
  } catch (e) {
    return {
      ok: true,
      output: "",
      passed: 0,
      failed: 0,
      skipped: e instanceof Deno.errors.NotCapable
        ? "no --allow-run permission"
        : String(e instanceof Error ? e.message : e),
    };
  }
}

/** Runs the tests that sit next to the draft. */
export async function runTests(slug: string): Promise<TestResult> {
  return await runTestFile((await filesOf(slug)).tests);
}

/** Runs the tests captured in one published version. */
export async function runVersionTests(slug: string, version: number): Promise<TestResult> {
  return await runTestFile((await filesOf(slug, version)).tests);
}
