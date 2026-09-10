/** @jsxImportSource ../../jsx */
import type { Ctx, FnConfig } from "../../lambdock.ts";

export const config: FnConfig = {
  description: "A new page",
  routes: [
    { method: "GET", path: "/" },
    { method: "GET", path: "/:name" },
  ],
};

export default function handler(_req: Request, ctx: Ctx) {
  return (
    <html>
      <body>
        <h1>Hello {ctx.params.name ?? "world"}</h1>
        <p>path: {ctx.path}</p>
      </body>
    </html>
  );
}
