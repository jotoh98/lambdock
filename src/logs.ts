import { config } from "./config.ts";

export interface LogLine {
  ts: number;
  slug: string;
  requestId: string;
  level: "log" | "info" | "warn" | "error" | "debug" | "system";
  text: string;
}

type Sink = (line: LogLine) => void;

const buffers = new Map<string, LogLine[]>();
const sinks = new Set<Sink>();

export function push(line: LogLine) {
  let buf = buffers.get(line.slug);
  if (!buf) buffers.set(line.slug, buf = []);
  buf.push(line);
  if (buf.length > config.logBuffer) buf.splice(0, buf.length - config.logBuffer);
  for (const s of sinks) {
    try {
      s(line);
    } catch { /* a dead stream must not break the request */ }
  }
}

export function recent(slug?: string): LogLine[] {
  if (slug) return [...(buffers.get(slug) ?? [])];
  return [...buffers.values()].flat().sort((a, b) => a.ts - b.ts).slice(-config.logBuffer);
}

export function clear(slug: string) {
  buffers.delete(slug);
}

export function subscribe(sink: Sink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

export function system(slug: string, text: string) {
  push({ ts: Date.now(), slug, requestId: "-", level: "system", text });
}

/** Turns console arguments into one readable line. */
export function format(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
    try {
      return Deno.inspect(a, { depth: 4, colors: false });
    } catch {
      return String(a);
    }
  }).join(" ");
}
