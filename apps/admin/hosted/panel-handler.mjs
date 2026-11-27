import { directoryPortrait,profileWithPortrait } from "./directory-photo.mjs";
import {isWorkspacePath} from "../src/page-url.js";
import {isUnifiedSite} from "./site.mjs";
import {runnerOperation,wakeRunner} from "./repository-jobs.mjs";
import { checkChatId, readChats, saveTurn } from "./chat-history.mjs";
import { available, answer, model } from "./openai-assistant.mjs";
import { authRoute, session, csrfCheck, sha } from "./auth.mjs";
import { HostedBackend } from "./backend.mjs";
import { ProposalStore } from "./store.mjs";
import { AdminService } from "../service-core.mjs";
import { PanelError } from "../errors.mjs";
import { json, boundedJson, secure } from "./http.mjs";
import { TRANSITION_POLICY } from "../../../packages/domain/src/transitions.ts";
import { previewFromSession, previewResponse, changePreview } from "./view-as.mjs";
import { browseState, browseProfiles } from "./browse.mjs";
import {rosterDataset,cohortNames} from "./roster-query.mjs";
import {rosterQuestion,rosterRows} from "./roster-questions.mjs";
import {prepareWingGrant,applyWingGrant} from "./wing-access.mjs";
import {currentAdministrators} from "./admin-directory.mjs";
import {reportTotals} from "./operational-reports.mjs";
import {eventCancellationReply} from "./event-action.mjs";
import { eventsState } from "./events-list.mjs";
import { dailyLimitResponse } from "./provider-errors.mjs";
import { memberCharts, wingCharts } from "./wing-charts.mjs";
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
        (!isUnifiedSite(env) && !env.APP_ORIGIN.includes("staging"))
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
        return secure(json({ status: "ok", ...(isUnifiedSite(env) ? {service:"SHAMROCK"} : {environment:"staging"}),
          ...(env.PANEL_DB?.status ? { controlStore: await env.PANEL_DB.status() } : {}) }));
      const runner = /^\/api\/assistant-runner\/(assistant-sandbox-[a-zA-Z0-9_-]+\.js)$/.exec(url.pathname);
      if (runner && request.method === "GET") {
        const asset = await env.ASSETS.fetch(new URL("/assets/"+runner[1], url));
        if (!asset.ok || !asset.headers.get("content-type")?.includes("javascript"))
          return secure(new Response("Unknown runner", {status:404}));
        const response = secure(asset);
        response.headers.set("Content-Security-Policy", "default-src 'none'; script-src 'wasm-unsafe-eval'; connect-src 'none'");
        return response;
      }
      const runnerRoute=/^\/api\/repository-runner\/(claim|finish)$/.exec(url.pathname);
      if(isUnifiedSite(env) && runnerRoute && request.method==="POST"){
        const input=await runnerOperation(request,runnerRoute[1]);
        return secure(json(await env.PANEL_DB.repositoryJob(input)));
      }
      const auth = await authRoute(request, env);
      if (auth) return secure(auth);
      if (url.pathname.startsWith("/auth/"))
        throw new PanelError(
          "NOT_FOUND",
          "This sign-in action is unavailable.",
          404,
        );
      if (!url.pathname.startsWith("/api/")) {
        const workspacePage = isWorkspacePath(url.pathname);
        const asset = await env.ASSETS.fetch(workspacePage ? new Request(new URL("/",url),request) : request);
        // Asset uploads may retain a stale binary MIME type for the HTML entry.
        // Keep nosniff and fix only the known successful document routes.
        if (
          asset.status === 200 &&
          (workspacePage || ["/", "/index.html"].includes(url.pathname))
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
          new ProposalStore(env.PANEL_DB, backend.binding, user.principal_id, preview ? null : user.token_hash),
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
      const cadetWorkspace = async section => {
        if (preview) {
          if (env.VIEW_AS_ENABLED !== "1" || preview.status !== "ready" || (request.method === "POST" && body?.entryAuditId !== preview.entry_audit_id)) throw new PanelError("VIEW_AS_READ_ONLY","Exit View as before making changes.",403);
          return backend.send("/v1/cadet/preview",{...backend.identity(),targetPersonId:preview.person_id,entryAuditId:preview.entry_audit_id,...(section?{section}:{}),...(request.method==="POST"?{action:body.action}:{})});
        }
        if (request.method==="POST" && body && "entryAuditId" in body) throw new PanelError("VIEW_AS_CHANGED","Reopen the selected workspace.",409);
        if (!user.schoolEmail) throw new PanelError("FORBIDDEN","Sign in with your school account.",403);
        const input={...backend.identity(),principalId:user.principal_id.startsWith("school.") ? "google."+await sha(user.schoolEmail) : user.principal_id,email:user.schoolEmail};
        if (request.method==="POST" && (!body || !body.kind)) throw new PanelError("INVALID_REQUEST","Choose a workspace action.");
        return backend.post("/v1/cadet/workspace",{...input,...(section?{section}:{}),...(request.method==="POST"?{action:body}:{})});
      };
      if (url.pathname === "/api/navigation" && request.method === "GET") {
        const include = url.searchParams.get("include");
        if (preview && (preview.status !== "ready" || env.VIEW_AS_ENABLED !== "1")) return secure(json({}));
        try {
          if (include === "personal") {
            if (!user.schoolEmail && !preview) return secure(json({}));
            const {registration, flightCommander, squadron} = await cadetWorkspace("profile");
            return secure(json({personal:{registration, flightCommander:!!flightCommander, squadron:!!squadron}}));
          }
          if (include === "leadership") {
            if (user.principal_id.startsWith("school.") && !user.wingAccess) return secure(json({}));
            const {access} = await backend.panelAuthority();
            return secure(json({leadership:{full:access.capabilities.fullSnapshot,
              assistantAvailable:access.capabilities.fullSnapshot && available(env,user,preview,access.capabilities),
              canViewAs:!preview && env.VIEW_AS_ENABLED==="1" && access.capabilities.canViewAs===true}}));
          }
        } catch (error) {
          if (error.status === 403) return secure(json({}));
          throw error;
        }
        throw new PanelError("INVALID_REQUEST","Unknown navigation request.");
      }
      if (url.pathname === "/api/directory/photo" && request.method === "GET") {
        return secure(await directoryPortrait(env, backend, user, preview, url.searchParams, () => cadetWorkspace("profile")));
      }
      if (url.pathname === "/api/cadet" && ["GET","POST"].includes(request.method)) {
        const expected=request.headers.get("x-shamrock-workspace");
        if(request.method==="GET" && expected!==null && expected!==(preview?.entry_audit_id ?? "self"))
          return secure(json({error:{code:"WORKSPACE_SWITCHED",message:"Your workspace changed in another tab.",
            workspace:preview || (user.principal_id.startsWith("school.") && !user.wingAccess) ? "personal" : "administrator"}},409));
        const section=url.searchParams.get("section");
        if(section!==null && !/^(?:report|flight):[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(section) && !["overview","profile","report","attendance","flight","excusals","directory","leadership"].includes(section))throw new PanelError("INVALID_REQUEST","Unknown workspace section.");
        const workspace=await cadetWorkspace(section);
        if (section==="overview" && workspace.overview && request.method==="GET") {
          workspace.compiled=await memberCharts(backend,workspace.stamp,()=>cadetWorkspace("overview-charts"));
        }
        return secure(json(section==="profile" && request.method==="GET" ? await profileWithPortrait(env,workspace) : workspace));
      }
      if (request.method === "POST" && url.pathname === "/api/view-as" &&
          (body?.personId === null || !user.principal_id.startsWith("school.") || user.wingAccess))
        return secure(json(await changePreview(env, user,
          new HostedBackend(env, user.principal_id), body)));
      if (user.principal_id.startsWith("school.") && !user.wingAccess) throw new PanelError("CADET_WORKSPACE","Open your cadet workspace.",403);
      const proposalPath=/^\/api\/proposals(?:\/[a-f0-9-]{36}\/(?:apply|cancel))?$/.test(url.pathname);
      if(request.method==="POST" && proposalPath && (body?.viewEntry ?? null)!==(preview?.entry_audit_id ?? null))
        throw new PanelError("VIEW_AS_READ_ONLY","Reload the workspace before saving.",403);
      backend.delegating=env.VIEW_AS_ENABLED==="1" && preview?.status==="ready";
      if (preview && !(backend.delegating && (proposalPath || ["/api/cadets/editor","/api/events/editor"].includes(url.pathname))) && ![
        "GET /api/state", "GET /api/wing-charts", "POST /api/page", "GET /api/history/list", "POST /api/history/page", "POST /api/history/report",
      ].includes(`${request.method} ${url.pathname}`))
        throw new PanelError("VIEW_AS_READ_ONLY", "Exit View as before making changes.", 403);
      const editorProfile = {"/api/view-as/people":"view-as-people", "/api/events/editor":"event-editor","/api/cadets/editor":"directory-editor"}[url.pathname];
      if(editorProfile==="view-as-people" && request.method==="GET"){
        if(preview || env.VIEW_AS_ENABLED!=="1")throw new PanelError("FORBIDDEN","View as is unavailable.",403);
        return secure(json(await backend.send("/v1/admin/panel/view-as/people",backend.identity())));
      }
      if (editorProfile && request.method === "GET") {
        const authority = await backend.panelAuthority();
        if (!authority.access.capabilities.fullSnapshot || (preview && !backend.delegating) ||
            (editorProfile === "view-as-people" && env.VIEW_AS_ENABLED !== "1"))
          throw new PanelError("FORBIDDEN","This page is outside your access.",403);
        return secure(json(await browseState(backend,authority,editorProfile,url.searchParams.get("id") || undefined)));
      }
      if (url.pathname === "/api/wing-charts" && request.method === "GET") {
        if (preview && preview.status !== "ready") throw new PanelError("VIEW_AS_CHANGED", "Reload Overview.", 403);
        return secure(json(await wingCharts(backend)));
      }
      if (url.pathname === "/api/state" && request.method === "GET") {
        const profile = url.searchParams.get("profile");
        if (profile !== null && !["events", "access", "full", ...browseProfiles].includes(profile))
          throw new PanelError("INVALID_REQUEST", "Reload SHAMROCK.");
        if (profile==="semester" && preview) throw new PanelError("VIEW_AS_READ_ONLY","Exit View as to use this page.",403);
        if (preview && preview.status !== "ready")
          return secure(json({ viewAs: previewResponse(preview), snapshot: null,
            meta: { hosted: true, viewAsEnabled: true } }));
        if (await backend.captureUnchanged(request.headers.get("x-shamrock-capture")))
          return secure(json({captureUnchanged:true,captureKey:backend.binding,
            viewAs:previewResponse(preview),viewAsRevision:backend.viewRevision,
            reportingTime:Date.now()}));
        const events = profile === "events" && !preview ? await eventsState(backend) : null;
        const browsing = browseProfiles.includes(profile);
        const authority = events?.authority ?? (browsing || profile === "events" || profile === "access" || (profile && !preview) ? (backend.checkedCapture?.current ?? await backend.panelAuthority()) : null);
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
        if (profile==="semester" && !authority?.access.capabilities.fullSnapshot) throw new PanelError("FORBIDDEN","This page is outside your access.",403);
        const scopedStart = (profile === "events" || profile === "access") && authority && !authority.access.capabilities.fullSnapshot;
        let browse;
        if (browsing || scopedStart || (preview && profile === "events"))
          browse = await browseState(backend,authority,scopedStart ? "attendance" : profile === "events" ? "event-list" : profile);
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
              delegatedEdits: !!backend.delegating,
              viewAsEnabled: env.VIEW_AS_ENABLED === "1" && manifest?.access?.capabilities?.canViewAs === true,
              assistantAvailable: available(env, user, preview, manifest.access.capabilities) && manifest.access.capabilities.fullSnapshot,
              model,
              transitionPolicy: TRANSITION_POLICY,
            },
          });
        if (browse) state.headers.set("Server-Timing", `browse;desc="${backend.browseSource}"`);
        return secure(state);
      }
      if (request.method === "GET" && url.pathname === "/api/system/diagnostics") {
        const view=await backend.send("/v1/admin/panel/browse",{...backend.identity(),profile:"diagnostics"});
        return secure(json({diagnostics:Object.entries(view.tables).filter(([,count])=>count>0).map(([code,count])=>({code,count}))}));
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
        return secure(await semesterHistory(backend, env.HISTORY_FILES, null, url.searchParams.get("include") === "latest"));
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
      const chatHistory=request.method==="GET" && url.pathname==="/api/chat/history";
      const testJob=["GET","POST"].includes(request.method) && url.pathname==="/api/chat/repository-test";
      const approveWing=request.method==="POST" && url.pathname==="/api/chat/wing-access";
      const adminDirectory=request.method==="GET" && url.pathname==="/api/chat/administrators";
      const rosterLookup=request.method==="GET" && url.pathname==="/api/chat/roster";
      const names=request.method==="POST" && url.pathname==="/api/chat/cohort-names";
      if (approveWing || names || rosterLookup || adminDirectory || testJob || chatHistory || (request.method==="POST" && url.pathname==="/api/chat")) {
        const {access}=await backend.panelAuthority();
        if (!access.capabilities.fullSnapshot || !available(env,user,preview,access.capabilities))
          throw new PanelError("FORBIDDEN","Assistant access is restricted.",403);
        const releaseOwner=env.ASSISTANT_OWNER_SUB===user.google_sub;
        if(testJob && !releaseOwner)throw new PanelError("FORBIDDEN","Website tests and releases require the SHAMROCK owner.",403);
        if(approveWing){
          if(body?.approved!==true)throw new PanelError("INVALID_REQUEST","Review and approve the named account.");
          return secure(json(await applyWingGrant(env,user.principal_id,checkChatId(body.id))));
        }
        const readRoster=async(withExcusals=false)=>{
          const authority=await backend.panelAuthority();
          const directory=await browseState(backend,authority,"cadets");
          const excusals=withExcusals ? await browseState(backend,authority,"excusals") : null;
          return rosterDataset(directory.tables,excusals?.tables);
        };
        if(names)return secure(json({rows:cohortNames(await readRoster(),body.ids)}));
        if(rosterLookup){
          const kind=url.searchParams.get("kind"),value=url.searchParams.get("value");
          if(!["birthday","flight"].includes(kind))throw new PanelError("INVALID_REQUEST","Unknown roster question.");
          const view=await browseState(backend,await backend.panelAuthority(),kind==="birthday"?"overview":"cadets");
          const rows=rosterRows(kind,value,view.tables);
          if(!rows)throw new PanelError("INVALID_REQUEST","Unknown roster filter.");
          return secure(json({rows}));
        }
        const readAccessDirectory=async()=>{
          if(!isUnifiedSite(env))throw new PanelError("UNAVAILABLE","Administrator records are unavailable here.",503);
          const panel=await currentAdministrators(env.DB);
          const workbook=await env.HISTORY_FILES.get("assistant/admin-directory/v1","json");
          return {...panel,workbook};
        };
        if(adminDirectory)return secure(json(await readAccessDirectory()));
        if(testJob){
          const approve=request.method==="POST";
          const id=checkChatId(approve?body?.id:url.searchParams.get("id"));
          if(approve && body.publishWebsite!==true)throw new PanelError("INVALID_REQUEST","Confirm that you want to update the website.");
          const result=await env.PANEL_DB.repositoryJob({operation:approve?"release":"status",id,currentCommit:env.maintenanceSource?.commit});
          if(approve && result?.state==="approved")await wakeRunner(env);
          return secure(json(result ?? {state:"expired"}));
        }
        const prefix="assistant/chat/v1/"+env.GENERATION+"/"+await sha(user.google_sub)+"/";
        if(chatHistory){
          if(!env.HISTORY_FILES)throw new PanelError("UNAVAILABLE","Saved chats are unavailable.",503);
          const history=await readChats(env.HISTORY_FILES,prefix,url.searchParams.get("id"));
          const fresh=(await backend.panelAuthority()).access.capabilities;
          if(!fresh.fullSnapshot || !available(env,user,preview,fresh))throw new PanelError("FORBIDDEN","Assistant access is restricted.",403);
          return secure(json(history));
        }
        const id=checkChatId(body?.chatId ?? crypto.randomUUID());
        const reply=rosterQuestion(body?.messages) ?? await eventCancellationReply(body?.messages?.at(-1),backend,service) ?? await answer(env,body,env.operatorGuide,fetch,()=>wingCharts(backend),async profile=>{
          const view=await browseState(backend,await backend.panelAuthority(),profile==="careers"?"cadets":profile);
          return reportTotals(profile,view.tables);
        },readRoster,readAccessDirectory,personId=>prepareWingGrant(env,user.principal_id,personId,sha));
        if(releaseOwner && isUnifiedSite(env) && reply.proposal){
          const {area,path,commit,before,after,edits}=reply.proposal;
          reply.proposal.jobId=await env.PANEL_DB.repositoryJob({operation:"create",id:crypto.randomUUID(),patch:{area,path,commit,before,after,edits}});
          if(reply.proposal.jobId)reply.proposal.dispatch=await wakeRunner(env);
        }
        let saved=false;
        try {
          const title=typeof body.chatTitle==="string" && body.chatTitle.trim() ? body.chatTitle : body.messages[0].content;
          await saveTurn(env.HISTORY_FILES,prefix,id,title,body.messages.at(-1).content,reply);
          saved=true;
        }catch{ /* Return the paid reply even if history storage is unavailable. */ }
        return secure(json({...reply,saved,chatId:id}));
      }
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
