import { authRoute, session, csrfCheck } from "./auth.mjs";
import { HostedBackend } from "./backend.mjs";
import { ProposalStore } from "./store.mjs";
import { AdminService } from "../service-core.mjs";
import { PanelError } from "../errors.mjs";
import { json, boundedJson, secure } from "./http.mjs";
import { TRANSITION_POLICY } from "../../../packages/domain/src/transitions.ts";
import { previewFromSession, previewResponse, changePreview } from "./view-as.mjs";
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
      if (!url.pathname.startsWith("/api/")) {
        const asset = await env.ASSETS.fetch(request);
        // Asset uploads may retain a stale binary MIME type for the HTML entry.
        // Keep nosniff and fix only the known successful document routes.
        if (
          asset.status === 200 &&
          ["/", "/index.html"].includes(url.pathname)
        ) {
          const headers = new Headers(asset.headers);
          headers.set("content-type", "text/html; charset=utf-8");
          return secure(
            new Response(asset.body, { status: asset.status, headers }),
          );
        }
        return secure(asset);
      }
      const user = await session(request, env),
        preview = previewFromSession(user),
        backend = new HostedBackend(env, user.principal_id, preview,
          url.pathname === "/api/state" ? null : request.headers.get("x-shamrock-view-revision")),
        service = new AdminService(
          backend,
          new ProposalStore(env.PANEL_DB, backend.binding, user.principal_id, user.token_hash),
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
      if (request.method === "POST" && url.pathname === "/api/view-as")
        return secure(json(await changePreview(env, user,
          new HostedBackend(env, user.principal_id), body)));
      if (preview && ![
        "GET /api/state", "POST /api/page", "GET /api/history/list", "POST /api/history/page",
      ].includes(`${request.method} ${url.pathname}`))
        throw new PanelError("VIEW_AS_READ_ONLY", "Exit View as before making changes.", 403);
      if (preview && url.pathname !== "/api/state" && !backend.viewRevision)
        throw new PanelError("SNAPSHOT_CHANGED", "Reload the selected view.", 409);
      if (url.pathname === "/api/state" && request.method === "GET") {
        if (preview && preview.status !== "ready")
          return secure(json({ viewAs: previewResponse(preview), snapshot: null,
            meta: { hosted: true, viewAsEnabled: true } }));
        const manifest = await backend.panelManifest();
        return secure(
          json({
            manifest,
            transport: "paged-v1",
            captureKey: backend.binding,
            viewAs: previewResponse(preview),
            viewAsRevision: backend.viewRevision,
            reportingTime: Date.now(),
            receiptsDeferred: !preview && manifest.access.capabilities.fullSnapshot,
            meta: {
              environment: "staging",
              fictional: true,
              hosted: true,
              viewAsEnabled: env.VIEW_AS_ENABLED === "1",
              assistantAvailable: false,
              transitionPolicy: TRANSITION_POLICY,
            },
          }),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/receipts") {
        const before = await backend.panelManifest();
        if (!before.access.capabilities.fullSnapshot)
          throw new PanelError("FORBIDDEN", "This page is outside your access.", 403);
        const receipts = await service.history();
        const after = await backend.panelManifest();
        if (!after.access.capabilities.fullSnapshot ||
            JSON.stringify(before.revision) !== JSON.stringify(after.revision))
          throw new PanelError("SNAPSHOT_CHANGED", "Records or access changed. Reload SHAMROCK.", 409);
        return secure(json({ contractVersion: "admin-receipts-v1", receipts }));
      }
      if (request.method === "POST" && url.pathname === "/api/page")
        return secure(json(await backend.page(body)));
      if (request.method === "GET" && url.pathname === "/api/history/list")
        return secure(json(await backend.historyPage(null)));
      if (request.method === "POST" && url.pathname === "/api/history/page")
        return secure(json(await backend.historyPage(body)));
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
      if (request.method === "GET" && url.pathname === "/api/transition") {
        if (!(await backend.panelManifest()).access.capabilities.fullSnapshot)
          throw new PanelError(
            "FORBIDDEN",
            "This page is outside your access.",
            403,
          );
        return secure(
          json(await service.transition(url.searchParams.get("id"))),
        );
      }
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
