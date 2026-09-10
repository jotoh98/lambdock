/** @jsxImportSource ../../jsx */
import type { Ctx, FnConfig } from "../../lambdock.ts";

export const config: FnConfig = {
  description: "An HTML page written in JSX, with a visit counter",
  routes: [{ method: "GET", path: "/" }],
};

function Layout(props: { title: string; children?: unknown }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{props.title}</title>
      </head>
      <body style={{ fontFamily: "system-ui", maxWidth: "40rem", margin: "2rem auto" }}>
        {props.children}
      </body>
    </html>
  );
}

export default async function handler(_req: Request, ctx: Ctx) {
  const visits = (await ctx.kv.get<number>("visits") ?? 0) + 1;
  await ctx.kv.set("visits", visits);
  const who = ctx.url.searchParams.get("name");

  return (
    <Layout title="lambdock page">
      <h1>Hello {who ?? "world"}</h1>
      <p>This page had {visits} {visits === 1 ? "visit" : "visits"}.</p>
      {who ? null : (
        <p>
          Add <code>?name=ada</code> to the URL.
        </p>
      )}
    </Layout>
  );
}
