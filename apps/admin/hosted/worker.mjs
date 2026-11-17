import { authRoute, session, csrfCheck } from "./auth.mjs";
import { HostedBackend } from "./backend.mjs";
import { ProposalStore } from "./store.mjs";
import { AdminService } from "../service-core.mjs";
import { PanelError } from "../errors.mjs";
import { json, boundedJson, secure } from "./http.mjs";
import { buildFrontendReporting } from "../../../packages/domain/src/frontend-reporting.ts";
import { snapshotToFrontendReportingInput } from "../../google-adapter/src/frontend-publication.ts";
import { TRANSITION_POLICY } from "../../../packages/domain/src/transitions.ts";
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (
        env.ENVIRONMENT !== "staging" ||
        url.origin !== env.APP_ORIGIN ||
        url.protocol !== "https:" ||
        !env.APP_ORIGIN.includes("staging")
      )
        throw new PanelError(
          "INVALID_HOST",
          "This SHAMROCK address is not available.",
          403,
        );
      if (url.pathname === "/health")
        return secure(json({ status: "ok", environment: "staging" }));
      const auth = await authRoute(request, env);
      if (auth) return secure(auth);
      if (url.pathname.startsWith("/auth/"))
        throw new PanelError(
          "NOT_FOUND",
          "This sign-in action is unavailable.",
          404,
        );
      if (!url.pathname.startsWith("/api/"))
        return secure(await env.ASSETS.fetch(request));
      const user = await session(request, env),
        backend = new HostedBackend(env, user.principal_id),
        service = new AdminService(
          backend,
          new ProposalStore(env.PANEL_DB, backend.binding, user.principal_id),
        );
      let body;
      if (request.method === "POST") {
        await csrfCheck(request, env, user);
        if (
          !request.headers.get("content-type")?.startsWith("application/json")
        )
          throw new PanelError(
            "INVALID_REQUEST",
            "Use the SHAMROCK panel to make this change.",
          );
        body = await boundedJson(request);
      }
      if (url.pathname === "/api/state" && request.method === "GET") {
        const snapshot = await service.snapshot(),
          date = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Indiana/Indianapolis",
          }).format(new Date());
        return secure(
          json({
            snapshot,
            reporting: buildFrontendReporting(
              snapshotToFrontendReportingInput(snapshot, date),
            ),
            history: await service.history(),
            meta: {
              environment: "staging",
              fictional: true,
              hosted: true,
              assistantAvailable: false,
              transitionPolicy: TRANSITION_POLICY,
            },
          }),
        );
      }
      if (request.method === "POST" && url.pathname === "/api/proposals")
        return secure(
          json(await service.propose(body.operation, body.payload)),
        );
      const action = url.pathname.match(
        /^\/api\/proposals\/([a-f0-9-]{36})\/(apply|cancel)$/,
      );
      if (request.method === "POST" && action)
        return secure(
          json(
            action[2] === "apply"
              ? await service.apply(action[1], body.approved)
              : await service.cancel(action[1]),
          ),
        );
      if (request.method === "GET" && url.pathname === "/api/transition")
        return secure(
          json(await service.transition(url.searchParams.get("id"))),
        );
      if (url.pathname === "/api/chat")
        throw new PanelError(
          "ASSISTANT_UNAVAILABLE",
          "The optional assistant is not connected. All administrator tools still work.",
          503,
        );
      throw new PanelError("NOT_FOUND", "This action is unavailable.", 404);
    } catch (error) {
      const status = error instanceof PanelError ? error.status : 400,
        code = error.code || "REQUEST_FAILED";
      if (url.pathname.startsWith("/auth/"))
        return secure(
          new Response(null, {
            status: 303,
            headers: {
              location:
                "/?signin=" +
                encodeURIComponent(
                  ["ACCESS_NOT_GRANTED", "SIGN_IN_LIMIT"].includes(code)
                    ? code
                    : "SIGN_IN_FAILED",
                ),
            },
          }),
        );
      return secure(
        json(
          {
            error: {
              code,
              message:
                error instanceof PanelError || error.name === "DomainError"
                  ? error.message
                  : "The request could not be completed. Reload before trying again.",
            },
          },
          status,
        ),
      );
    }
  },
  async scheduled(_event, env) {
    // Bounded cleanup only for expired authentication material; operation receipts remain intact.
    for (const [table, key] of [
      ["oauth_states", "state_hash"],
      ["sessions", "token_hash"],
      ["auth_limits", "bucket"],
    ])
      await env.PANEL_DB.prepare(
        `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE expires<? LIMIT 500)`,
      )
        .bind(Date.now())
        .run();
    await env.PANEL_DB.prepare(
      "DELETE FROM proposals WHERE id IN (SELECT id FROM proposals WHERE lease_until<? AND ((state IN ('proposed','cancelled','conflict','rejected') AND created<?) OR (state='complete' AND created<?)) LIMIT 100)",
    )
      .bind(Date.now(), Date.now() - 30 * 86400000, Date.now() - 90 * 86400000)
      .run();
  },
};
