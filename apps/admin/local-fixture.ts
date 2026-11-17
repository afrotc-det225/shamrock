// Local Miniflare fixture only. Never use this entry point for deployment.
import worker from "../worker/src/index";
export default {
  async fetch(request: Request, env: any, context: any) {
    if (
      new URL(request.url).pathname === "/__local_fixture" &&
      env.ENVIRONMENT === "local" &&
      request.headers.get("x-fixture-secret") === env.BRIDGE_SECRET
    ) {
      const input = (await request.json()) as {
        statements: { sql: string; values: unknown[] }[];
      };
      return Response.json(
        await env.DB.batch(
          input.statements.map((s) => env.DB.prepare(s.sql).bind(...s.values)),
        ),
      );
    }
    return worker.fetch(request, env, context);
  },
};
