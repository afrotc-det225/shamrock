import { authRoute, session, csrfCheck } from "./auth.mjs";
import { HostedBackend } from "./backend.mjs";
import { ProposalStore } from "./store.mjs";
import { AdminService } from "../service-core.mjs";
import { PanelError } from "../errors.mjs";
import { json, boundedJson, secure } from "./http.mjs";
import { TRANSITION_POLICY } from "../../../packages/domain/src/transitions.ts";
import { previewFromSession, previewResponse, changePreview } from "./view-as.mjs";
import { browseState, browseProfiles } from "./browse.mjs";
import { eventsState } from "./events-list.mjs";
import { dailyLimitResponse } from "./provider-errors.mjs";
import { semesterHistory } from "./semester-history.mjs";
export default {
  async fetch(request, env, controlStoreFactory) {
    const url = new URL(request.url);
    // The permanent host is a second entrance to this same real-data staging
    // installation. Keep the control store, pending proposals and cleanup job shared.
    const canonical = url.origin === "https://shamrock.det225.workers.dev" &&
      env.APP_ORIGIN === "https://shamrock-admin-staging.det225.workers.dev" &&
      env.STAGING_DATASET === "real" &&
      env.BACKEND_SERVICE_NAME === "shamrock-real-parity" &&
      env.BACKEND_ORIGIN === "https://shamrock-real-parity.det225.workers.dev";
    try {
      if (
        env.ENVIRONMENT !== "staging" ||
        (!canonical && url.origin !== env.APP_ORIGIN) ||
        url.protocol !== "https:" ||
        !env.APP_ORIGIN.includes("staging")
      )
        throw new PanelError(
          "INVALID_HOST",
          "This SHAMROCK address is not available.",
          403,
        );
      if (controlStoreFactory && (url.pathname === "/health" ||
          url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/")))
        env = { ...env, PANEL_DB: controlStoreFactory(env) };
      if (canonical) env = { ...env, APP_ORIGIN: url.origin };
      if (url.pathname === "/health")
        return secure(json({ status: "ok", environment: "staging",
          ...(env.PANEL_DB?.status ? { controlStore: await env.PANEL_DB.status() } : {}) }));
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
        backend = new HostedBackend(env, user.principal_id, preview),
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
        "GET /api/state", "POST /api/page", "GET /api/history/list", "POST /api/history/page", "POST /api/history/report",
      ].includes(`${request.method} ${url.pathname}`))
        throw new PanelError("VIEW_AS_READ_ONLY", "Exit View as before making changes.", 403);
      if (url.pathname === "/api/state" && request.method === "GET") {
        const profile = url.searchParams.get("profile");
        if (profile !== null && !["events", "access", "full", ...browseProfiles].includes(profile))
          throw new PanelError("INVALID_REQUEST", "Reload SHAMROCK.");
        if (preview && preview.status !== "ready")
          return secure(json({ viewAs: previewResponse(preview), snapshot: null,
            meta: { hosted: true, viewAsEnabled: true } }));
        if (await backend.captureUnchanged(request.headers.get("x-shamrock-capture")))
          return secure(json({captureUnchanged:true,captureKey:backend.binding,
            viewAs:previewResponse(preview),viewAsRevision:backend.viewRevision,
            reportingTime:Date.now()}));
        const events = profile === "events" && !preview ? await eventsState(backend) : null;
        const browsing = browseProfiles.includes(profile);
        const authority = events?.authority ?? (browsing || profile === "events" || (profile && !preview) ? (backend.checkedCapture?.current ?? await backend.panelAuthority()) : null);
        if (profile==="attendance" && request.headers.get("x-shamrock-delta")==="corrections-v1" &&
            !preview && authority?.access.capabilities.fullSnapshot && backend.checkedCapture) {
          const previous=backend.checkedCapture.expected.revision;
          if (previous?.access===authority.revision.access && previous.administration===authority.revision.administration &&
              Number.isSafeInteger(previous.operations) && previous.operations<authority.revision.operations &&
              authority.revision.operations-previous.operations<=64) {
            const delta=await backend.post("/v1/admin/panel/attendance-delta",{...backend.identity(),
              termId:authority.scope.termId,access:previous.access,administration:previous.administration,from:previous.operations});
            if (delta.available) return secure(json({attendanceDelta:delta,captureKey:backend.binding,reportingTime:Date.now()}));
          }
        }
        const scopedStart = profile === "events" && authority && !authority.access.capabilities.fullSnapshot;
        let browse;
        if (browsing || scopedStart) {
          try { browse = await browseState(backend,authority,scopedStart ? "attendance" : profile); }
          catch (error) { if (!["BROWSE_TOO_LARGE","TOO_LARGE"].includes(error.code)) throw error; }
        }
        const manifest = browse || authority?.access.capabilities.fullSnapshot
          ? {...authority, section:"manifest", sections:[], partial:true}
          : await backend.panelManifest();

        const state = json({
            manifest,
            ...(browse ? {browse} : {}),
            ...(events ? {eventsList:events.eventsList} : {}),
            ...(backend.snapshotManifest ? {snapshotManifest:backend.snapshotManifest} : {}),
            transport: "paged-v1",
            captureKey: backend.binding,
            viewAs: previewResponse(preview),
            viewAsRevision: backend.viewRevision,
            reportingTime: Date.now(),
            receiptsDeferred: !preview && manifest.access.capabilities.fullSnapshot,
            meta: {
              environment: "staging",
              fictional: backend.dataset === "fictional",
              hosted: true,
              viewAsEnabled: env.VIEW_AS_ENABLED === "1",
              assistantAvailable: false,
              transitionPolicy: TRANSITION_POLICY,
            },
          });
        if (browse) state.headers.set("Server-Timing", `browse;desc="${backend.browseSource}"`);
        return secure(state);
      }
      if (request.method === "GET" && url.pathname === "/api/receipts") {
        const before = await backend.panelAuthority();
        if (!before.access.capabilities.fullSnapshot)
          throw new PanelError("FORBIDDEN", "This page is outside your access.", 403);
        const receipts = await service.history();
        const after = await backend.panelAuthority();
        if (!after.access.capabilities.fullSnapshot ||
            JSON.stringify(before.revision) !== JSON.stringify(after.revision))
          throw new PanelError("SNAPSHOT_CHANGED", "Records or access changed. Reload SHAMROCK.", 409);
        return secure(json({ contractVersion: "admin-receipts-v1", receipts }));
      }
      if (request.method === "POST" && url.pathname === "/api/page")
        return secure(json(await backend.page(body)));
      if (env.HISTORY_FILES && url.pathname === "/api/history/list" && request.method === "GET")
        return secure(await semesterHistory(backend, env.HISTORY_FILES, null));
      if (env.HISTORY_FILES && url.pathname === "/api/history/report" && request.method === "POST") {
        if (!body || typeof body.version !== "string" || !/^[a-f0-9]{64}$/.test(body.version))
          throw new PanelError("INVALID_REQUEST", "Select a semester from History.");
        return secure(await semesterHistory(backend, env.HISTORY_FILES, body));
      }
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
        if (!(await backend.panelAuthority()).access.capabilities.fullSnapshot)
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
      const limited = dailyLimitResponse(error, url);
      if (limited) return secure(limited);
      const status = error instanceof PanelError ? error.status : 400,
        code = error.code || "REQUEST_FAILED";
      if (url.pathname.startsWith("/auth/") && url.pathname !== "/auth/logout")
        return secure(
          new Response(null, {
            status: 303,
            headers: {
              location:
                "/?signin=" +
                encodeURIComponent(
                  ["ACCESS_NOT_GRANTED", "SIGN_IN_LIMIT", "AUTH_STORE_UNAVAILABLE"].includes(code)
                    ? code
                    : "SIGN_IN_FAILED",
                ),
            },
          }),
        );
      const response = json({ error: {
        code,
        message: error instanceof PanelError || error.name === "DomainError"
          ? error.message
          : "The request could not be completed. Reload before trying again.",
      } }, status);
      if (error instanceof PanelError && status >= 500 &&
          Number.isSafeInteger(error.retryAfterSeconds) &&
          error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 86400)
        response.headers.set("Retry-After", String(error.retryAfterSeconds));
      return secure(response);
    }
  },
  async scheduled(_event, env, controlStoreFactory) {
    if (controlStoreFactory) env = { ...env, PANEL_DB: controlStoreFactory(env) };
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
