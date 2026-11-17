// Test-only entry point. No route in this module belongs in a hosted deployment.
import worker from "../hosted/worker.mjs";
export default {
  async fetch(request, env, ctx) {
    if (
      new URL(request.url).pathname === "/__fixture" &&
      request.headers.get("x-fixture-secret") === env.TEST_SECRET
    ) {
      const input = await request.json();
      if (input.cleanup) {
        await worker.scheduled({}, env);
        return Response.json({ cleaned: true });
      }
      return Response.json(
        await env.PANEL_DB.batch(
          input.statements.map((s) =>
            env.PANEL_DB.prepare(s.sql).bind(...(s.values || [])),
          ),
        ),
      );
    }
    return worker.fetch(request, env, ctx);
  },
};
