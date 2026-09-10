/**
 * Starts lambdock in a real container for the end-to-end tests.
 * Works with docker and with podman, locally and on a runner.
 */

export type Runtime = "docker" | "podman";

const IMAGE = Deno.env.get("LAMBDOCK_E2E_IMAGE") ?? "lambdock:e2e";
const NAME = Deno.env.get("LAMBDOCK_E2E_NAME") ?? "lambdock-e2e";
const ROOT = new URL("../", import.meta.url).pathname;

async function run(
  cmd: string,
  args: string[],
  opts: { quiet?: boolean } = {},
): Promise<{ code: number; out: string; err: string }> {
  const child = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: opts.quiet ? "piped" : "inherit",
  });
  const res = await child.output();
  const dec = new TextDecoder();
  return {
    code: res.code,
    out: dec.decode(res.stdout).trim(),
    err: opts.quiet ? dec.decode(res.stderr).trim() : "",
  };
}

/** The first container runtime on the PATH. docker first, because runners have it. */
export async function detectRuntime(): Promise<Runtime> {
  const wanted = Deno.env.get("LAMBDOCK_E2E_RUNTIME");
  if (wanted === "docker" || wanted === "podman") return wanted;
  for (const candidate of ["docker", "podman"] as const) {
    try {
      const { code } = await run(candidate, ["version", "--format", "{{.Client.Version}}"], {
        quiet: true,
      });
      if (code === 0) return candidate;
    } catch { /* not installed */ }
  }
  throw new Error(
    "No container runtime found. Install docker or podman, or set LAMBDOCK_E2E_RUNTIME.",
  );
}

export interface Container {
  runtime: Runtime;
  name: string;
  /** Base URL of the server inside the container. */
  url: string;
  /** Runs a command inside the container and returns its output. */
  exec(args: string[]): Promise<{ code: number; out: string }>;
  /** Reads the container log, for a failure message. */
  logs(): Promise<string>;
  stop(): Promise<void>;
}

/** Builds the image when the tag is not there yet. CI builds it beforehand. */
async function ensureImage(runtime: Runtime) {
  const { code } = await run(runtime, ["image", "inspect", IMAGE], { quiet: true });
  if (code === 0) return;
  console.log(`building ${IMAGE} …`);
  const build = await run(runtime, ["build", "-t", IMAGE, "-f", `${ROOT}Dockerfile`, ROOT]);
  if (build.code !== 0) throw new Error(`could not build ${IMAGE}`);
}

/** Removes a container of an earlier run that did not clean up. */
async function removeStale(runtime: Runtime, name: string) {
  await run(runtime, ["rm", "-f", name], { quiet: true });
}

/** Asks the operating system for a free port. Docker takes 0, podman does not. */
function freePort(): number {
  const listener = Deno.listen({ port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

export async function startContainer(): Promise<Container> {
  const runtime = await detectRuntime();
  await ensureImage(runtime);
  await removeStale(runtime, NAME);

  // A port of our own choosing, so two runs on one machine cannot collide.
  const port = freePort();
  const started = await run(runtime, [
    "run",
    "-d",
    "--name",
    NAME,
    "-p",
    `${port}:8000`,
    IMAGE,
  ], { quiet: true });
  if (started.code !== 0) {
    throw new Error(`could not start ${IMAGE}:\n${started.err || started.out}`);
  }

  const url = `http://127.0.0.1:${port}`;

  const container: Container = {
    runtime,
    name: NAME,
    url,
    async exec(args) {
      const res = await run(runtime, ["exec", NAME, ...args], { quiet: true });
      return { code: res.code, out: [res.out, res.err].filter(Boolean).join("\n") };
    },
    async logs() {
      const { out } = await run(runtime, ["logs", NAME], { quiet: true });
      return out;
    },
    async stop() {
      await removeStale(runtime, NAME);
    },
  };

  // The server answers /__/api/health as soon as it is ready.
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${url}/__/api/health`);
      await res.body?.cancel();
      if (res.ok) return container;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const log = await container.logs();
  await container.stop();
  throw new Error(`the container did not become healthy:\n${log}`);
}
