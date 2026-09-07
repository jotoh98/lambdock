import type { Ctx, FnConfig } from "../../lambdock.ts";

export const config: FnConfig = {
  description: "A new function",
  routes: [
    { method: "GET", path: "/" },
    { method: "GET", path: "/:name" },
  ],
};

export default function handler(_req: Request, ctx: Ctx) {
  return { hello: ctx.params.name ?? "world", path: ctx.path };
}
