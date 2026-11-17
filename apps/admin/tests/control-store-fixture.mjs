// Test-only entry. Never bundle or deploy this fixture as the hosted Worker.
import worker from "../hosted/worker.mjs";
import { panelControlStore } from "../hosted/control-store.mjs";
import { authRoute } from "../hosted/auth.mjs";
export { StagingPanelStore } from "../hosted/control-store-object.mjs";

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== "/__fixture" ||
        request.headers.get("x-fixture-secret") !== env.TEST_SECRET)
      return worker.fetch(request, env, ctx);
    try {
      const input = await request.json();
      const db = panelControlStore(env);
      if (input.status) return Response.json(await db.status());
      if (input.callback) {
        return await authRoute(new Request(input.callback.url, {
          headers: {cookie: input.callback.cookie},
        }), {...env, PANEL_DB: db}, {
          fetcher: async (_url, options) => {
            if (!options.body.get("code_verifier")) throw Error("Missing PKCE verifier");
            return Response.json({id_token: "verified-fixture-token"});
          },
          verify: async (_token, _clientId, nonce) => {
            if (nonce !== input.callback.nonce) throw Error("Wrong nonce");
            return input.callback.identity;
          },
        });
      }
      return Response.json(await db.batch(input.statements.map(({sql, values = []}) =>
        db.prepare(sql).bind(...values))));
    } catch (error) {
      return Response.json({error:{code:error.code || "FIXTURE_ERROR"}}, {status:error.status || 500});
    }
  },
};
