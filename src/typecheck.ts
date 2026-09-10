import { config } from "./config.ts";
import { filesOf } from "./store.ts";

export interface CheckResult {
  ok: boolean;
  /** Raw diagnostics of `deno check`. Empty when the code is valid. */
  output: string;
  skipped?: string;
}

/**
 * Runs `deno check` on one file in a subprocess.
 * It needs --allow-run. When that is missing the check is skipped, not fatal.
 */
export async function checkFile(file: string): Promise<CheckResult> {
  if (!config.typeCheck) {
    return { ok: true, output: "", skipped: "disabled by LAMBDOCK_TYPECHECK=0" };
  }
  try {
    const cmd = new Deno.Command(Deno.execPath(), {
      // --no-config: the check must not inherit the server's deno.json,
      // which excludes the data directory and would silently skip the file.
      args: ["check", "--no-lock", "--no-config", "--quiet", file],
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
    }, 30_000);
    const out = await child.output();
    clearTimeout(timeout);
    const text = (new TextDecoder().decode(out.stderr) + new TextDecoder().decode(out.stdout))
      .trim();
    return { ok: out.code === 0, output: text };
  } catch (e) {
    return {
      ok: true,
      output: "",
      skipped: e instanceof Deno.errors.NotCapable
        ? "no --allow-run permission"
        : String(e instanceof Error ? e.message : e),
    };
  }
}

/** Checks the draft of a function. */
export async function checkFunction(slug: string): Promise<CheckResult> {
  return await checkFile((await filesOf(slug)).handler);
}

/** Checks one published version. */
export async function checkVersion(slug: string, version: number): Promise<CheckResult> {
  return await checkFile((await filesOf(slug, version)).handler);
}
