import type { Ctx, FnConfig } from "../../lambdock.ts";

export const config: FnConfig = {
  description: "Reflects the request back. Matches every method and sub-path.",
  routes: [{ method: "*", path: "/*" }],
};

export default async function handler(req: Request, ctx: Ctx) {
  let body: unknown = null;
  if (req.body) {
    const text = await req.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    method: req.method,
    path: ctx.path,
    params: ctx.params,
    query: Object.fromEntries(ctx.url.searchParams),
    headers: Object.fromEntries(req.headers),
    body,
  };
}
