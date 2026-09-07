import type { Ctx, FnConfig } from "../../lambdock.ts";

export const config: FnConfig = {
  description: "A small CRUD API on the persistent key-value store",
  routes: [
    { method: "GET", path: "/" },
    { method: "POST", path: "/" },
    { method: "GET", path: "/:id" },
    { method: "DELETE", path: "/:id" },
  ],
};

interface Todo {
  id: string;
  title: string;
  done: boolean;
}

export default async function handler(req: Request, ctx: Ctx) {
  const { id } = ctx.params;

  if (req.method === "GET" && !id) {
    const rows = await ctx.kv.list<Todo>();
    return rows.map((r) => r.value);
  }

  if (req.method === "POST") {
    const input = await req.json() as Partial<Todo>;
    if (!input.title) return new Response("title is required", { status: 400 });
    const todo: Todo = { id: crypto.randomUUID(), title: input.title, done: false };
    await ctx.kv.set(todo.id, todo);
    return new Response(JSON.stringify(todo), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method === "GET" && id) {
    const todo = await ctx.kv.get<Todo>(id);
    return todo ?? new Response("not found", { status: 404 });
  }

  if (req.method === "DELETE" && id) {
    await ctx.kv.delete(id);
    return new Response(null, { status: 204 });
  }

  return new Response("method not allowed", { status: 405 });
}
