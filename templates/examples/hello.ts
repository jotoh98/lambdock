import type { Ctx, FnConfig } from "../../lambdock.ts";

export const config: FnConfig = {
  description: "Greeting with a path parameter",
  routes: [
    { method: "GET", path: "/" },
    { method: "GET", path: "/:name" },
  ],
};

export default function handler(_req: Request, ctx: Ctx) {
  const name = ctx.params.name ?? "world";
  console.log("greeting", name);
  return { hello: name, at: new Date().toISOString() };
}
