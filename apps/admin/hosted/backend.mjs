import { createHash, createHmac } from "node:crypto";
import { PanelError } from "../errors.mjs";
import { boundedJson } from "./http.mjs";
const paths = new Set([
  "/v1/cadet/known","/v1/cadet/workspace","/v1/cadet/preview",
  "/v1/admin/panel/view-as/authorize",
  "/v1/admin/panel/view-as/page",
  "/v1/admin/panel/view-as/access",
  "/v1/admin/history/list",
  "/v1/admin/history/page",
  "/v1/admin/snapshot/page",
  "/v1/admin/panel/page",
  "/v1/admin/panel/access",
  "/v1/admin/panel/browse",
  "/v1/admin/panel/attendance-delta",
  "/v1/admin/panel/authorize",
  "/v1/admin/panel/commands",
  "/v1/admin/commands",
  "/v1/commands",
  "/v1/admin/transitions/status",
  "/v1/admin/transitions/commands",
  "/v1/admin/transitions/prepare/begin",
  "/v1/admin/transitions/prepare/step",
]);
export class HostedBackend {
  constructor(env, principalId, preview = null) {
    const origin = new URL(env.BACKEND_ORIGIN);
    const dataset = env.STAGING_DATASET ?? "fictional";
    const realStaging = dataset === "real" &&
      typeof env.BACKEND_SERVICE_NAME === "string" &&
      /^[a-z0-9-]+-real-parity$/.test(env.BACKEND_SERVICE_NAME) &&
      origin.hostname === `${env.BACKEND_SERVICE_NAME}.${origin.hostname.split(".")[1]}.workers.dev` &&
      !origin.port;
    if (
      env.ENVIRONMENT !== "staging" ||
      !(dataset === "fictional" && origin.hostname.includes("staging") || realStaging) ||
      origin.protocol !== "https:" ||
      origin.origin !== env.BACKEND_ORIGIN ||
      !env.BACKEND ||
      !env.BRIDGE_SECRET ||
      env.BRIDGE_SECRET.length < 32 ||
      !["sheet", "test"].includes(env.SOURCE_KIND)
    )
      throw new PanelError(
        "CONFIGURATION",
        "SHAMROCK is not ready. Please contact the administrator.",
        503,
      );
    this.env = env;
    this.dataset = dataset;
    this.principalId = principalId;
    this.preview = preview;
    this.viewRevision = null;
    this.environment = "staging";
    this.generation = Number(env.GENERATION);
    this.calls = 0;
    if (!Number.isSafeInteger(this.generation) || this.generation < 1)
      throw new PanelError(
        "CONFIGURATION",
        "The system binding is unavailable.",
        503,
      );
    this.binding = createHash("sha256")
      .update(
        JSON.stringify([
          env.BACKEND_ORIGIN,
          this.generation,
          principalId,
          env.SOURCE_KIND,
          env.SOURCE_RESOURCE,
          env.BRIDGE_KEY_ID,
          ...(preview ? [preview.entry_audit_id] : []),
        ]),
      )
      .digest("hex");
  }
  identity() {
    return {
      environment: "staging",
      generation: this.generation,
      principalId: this.principalId,
    };
  }
  envelope(operation, payload, commandId) {
    return {
      contractVersion: 1,
      environment: "staging",
      generation: this.generation,
      commandId,
      actor: {
        principalId: this.principalId,
        evidence: "authenticated-confirmation",
      },
      source: {
        kind: this.env.SOURCE_KIND,
        resourceKey: this.env.SOURCE_RESOURCE,
        submissionId: commandId,
        revision: 1,
      },
      operation,
      payload,
    };
  }
  async post(path, input) {
    if (this.preview) throw new PanelError("VIEW_AS_READ_ONLY", "Exit View as before making changes.", 403);
    return this.send(path, input);
  }
  async previewPage(kind, page, viewRevision = null) {
    const start = kind === "history-list" ? Object.keys(page).length === 0 :
      page.section === "manifest" && page.offset === 0 && (kind === "history" ? page.sourceSnapshotSha256 === null : page.revision === null) ||
      kind === "snapshot" && ["term-catalog","directory-catalog","contacts-catalog"].includes(page.section) && page.offset === 0 && page.revision === null;
    if ((viewRevision === null) !== start)
      throw new PanelError("SNAPSHOT_CHANGED","Reload the selected view.",409);
    const identity = this.identity();
    const result = await this.send("/v1/admin/panel/view-as/page", {
      ...identity, targetPersonId: this.preview.person_id,
      entryAuditId: this.preview.entry_audit_id, viewRevision, kind, page,
    });
    if (result.contractVersion !== "panel-view-as-page-v1" || result.readOnly !== true ||
        result.kind !== kind || result.environment !== identity.environment || result.generation !== identity.generation ||
        result.entryAuditId !== this.preview.entry_audit_id || result.targetPersonId !== this.preview.person_id ||
        typeof result.viewRevision !== "string" || !/^[a-f0-9]{64}$/.test(result.viewRevision) ||
        (viewRevision !== null && result.viewRevision !== viewRevision))
      throw new PanelError("SNAPSHOT_CHANGED", "Access changed. Reload this view.", 409);
    return {...result.page, viewRevision: result.viewRevision};
  }
  async send(path, input) {
    if (!paths.has(path))
      throw new PanelError("INVALID_ACTION", "This operation is unavailable.");
    if (++this.calls > 30)
      throw new PanelError(
        "TRANSFER_LIMIT",
        "This operation needs another batch. Retry the saved change.",
        503,
      );
    const body = JSON.stringify(input);
    if (new TextEncoder().encode(body).length > 65536)
      throw new PanelError("TOO_LARGE", "Please make a smaller change.", 413);
    const timestamp = String(Math.floor(Date.now() / 1000)),
      signature = createHmac("sha256", this.env.BRIDGE_SECRET)
        .update(
          `POST\n${path}\n${timestamp}\n${createHash("sha256").update(body).digest("hex")}`,
        )
        .digest("hex");
    let response;
    try {
      response = await this.env.BACKEND.fetch(
        new Request(this.env.BACKEND_ORIGIN + path, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(30000),
          headers: {
            "content-type": "application/json",
            "x-shamrock-key-id": this.env.BRIDGE_KEY_ID,
            "x-shamrock-timestamp": timestamp,
            "x-shamrock-signature": signature,
          },
          body,
        }),
      );
    } catch {
      throw new PanelError(
        "CONNECTION_INTERRUPTED",
        "The response was interrupted. Retry the saved change.",
        503,
      );
    }
    const result = await boundedJson(response, ["/v1/admin/panel/browse", "/v1/cadet/workspace", "/v1/cadet/preview"].includes(path) ? 2000000 : 150000);
    if (!response.ok) {
      const error = new PanelError(
        result.error?.code || "BACKEND_ERROR",
        result.error?.message || "The operation could not be completed.",
        response.status,
      );
      const retryAfter = response.headers.get("retry-after");
      if (response.status >= 500 && /^\d+$/.test(retryAfter || "") &&
          Number(retryAfter) >= 1 && Number(retryAfter) <= 86400)
        error.retryAfterSeconds = Number(retryAfter);
      throw error;
    }
    return result;
  }
  async authorizeOperation(operation, payload) {
    if (["excusal.decide", "attendance.correct"].includes(operation)) {
      const target =
        operation === "excusal.decide"
          ? { requestId: payload?.requestId }
          : { personId: payload?.personId, eventId: payload?.eventId };
      return this.post("/v1/admin/panel/authorize", {
        ...this.identity(),
        operation,
        target,
      });
    }
    const manifest = await this.panelAuthority();
    if (!manifest.access.capabilities.fullSnapshot)
      throw new PanelError(
        "FORBIDDEN",
        "This action is outside your access.",
        403,
      );
    return manifest;
  }
  async previewContext(operation, payload) {
    const authority = await this.authorizeOperation(operation, payload);
    if (authority.current) {
      for (const key of [
        "expectedVersion",
        "expectedBaseVersion",
        "expectedEventVersion",
      ])
        if (key in authority.current && payload[key] !== authority.current[key])
          throw new PanelError(
            "STALE_VERSION",
            "This record changed. Reload it before saving.",
            409,
          );
    }
    return { proposedValuesOnly: true, events: [], people: [], leadership: [] };
  }
  submit(command) {
    const path = ["excusal.decide", "attendance.correct"].includes(
      command.operation,
    )
      ? "/v1/admin/panel/commands"
      : command.operation.startsWith("transition.")
        ? "/v1/admin/transitions/commands"
        : "/v1/admin/commands";
    return this.post(path, command);
  }
  async panelManifest(sections) {
    if (this.preview) {
      const authority = await this.send("/v1/admin/panel/view-as/authorize", {
        ...this.identity(), action: "enter", auditId: this.preview.entry_audit_id,
        targetPersonId: this.preview.person_id,
      });
      if (authority.status !== "ready" || !authority.access)
        throw new PanelError("VIEW_AS_CHANGED", "This account's access changed. Exit and select it again.", 409);
      const full = authority.access.capabilities.fullSnapshot;
      const manifest = await this.previewPage(full ? "snapshot" : "panel", {section:"manifest",offset:0,revision:null});
      this.viewRevision = manifest.viewRevision;
      if (!full) return manifest;
      this.snapshotManifest = manifest;
      return {...manifest, contractVersion:"panel-view-as-manifest-v1", access:authority.access,
        revision:{...manifest.revision,access:manifest.viewRevision}};
    }
    return this.post("/v1/admin/panel/page", {
      ...this.identity(),
      section: "manifest",
      offset: 0,
      revision: null,
      ...(sections === undefined ? {} : { sections }),
    });
  }
  async panelAuthority() {
    if (this.preview) {
      const result = await this.send("/v1/admin/panel/view-as/access", {
        ...this.identity(), targetPersonId: this.preview.person_id,
        entryAuditId: this.preview.entry_audit_id,
      });
      if (result.contractVersion !== "panel-view-as-access-v1" || result.readOnly !== true ||
          result.environment !== this.environment || result.generation !== this.generation ||
          result.entryAuditId !== this.preview.entry_audit_id || result.targetPersonId !== this.preview.person_id ||
          typeof result.viewRevision !== "string" || !/^[a-f0-9]{64}$/.test(result.viewRevision))
        throw new PanelError("VIEW_AS_CHANGED", "Reload the selected view.", 409);
      this.viewRevision = result.viewRevision;
      return result;
    }
    return this.post("/v1/admin/panel/access", this.identity());
  }
  async captureUnchanged(encoded) {
    if (!encoded) return false;
    let expected;
    try { if(encoded.length > 1024) throw Error(); expected=JSON.parse(decodeURIComponent(encoded)); }
    catch { throw new PanelError("INVALID_REQUEST", "Reload SHAMROCK."); }
    if (!expected || Object.keys(expected).sort().join(',') !== 'captureKey,revision,viewAsRevision')
      throw new PanelError("INVALID_REQUEST", "Reload SHAMROCK.");
    // The browser supplies only a comparison value, never authorization or rows.
    // A changed actor/binding must obtain a new capture before any reuse.
    if (expected.captureKey !== this.binding) return false;
    const current=await this.panelAuthority();
    this.checkedCapture = {expected,current};
    return JSON.stringify(expected.revision)===JSON.stringify(current.revision) &&
      expected.viewAsRevision===(this.viewRevision??null);
  }
  async historyPage(input) {
    if (this.preview) {
      if (input === null) return this.previewPage("history-list", {});
      return this.previewPage("history", {snapshotId:input.snapshotId,section:input.section,
        offset:input.offset,sourceSnapshotSha256:input.sourceSnapshotSha256},input.viewRevision ?? null);
    }
    const before = await this.panelAuthority();
    if (!before.access.capabilities.fullSnapshot)
      throw new PanelError("FORBIDDEN", "This page is outside your access.", 403);
    let result;
    if (input === null) {
      result = await this.post("/v1/admin/history/list", this.identity());
    } else {
      if (!input || typeof input.snapshotId !== "string" ||
          !["manifest", "roster", "rows", "verify"].includes(input.section) ||
          !Number.isSafeInteger(input.offset) || input.offset < 0)
        throw new PanelError("INVALID_REQUEST", "This report is unavailable.");
      result = await this.post("/v1/admin/history/page", {
        ...this.identity(), snapshotId: input.snapshotId,
        section: input.section, offset: input.offset,
        sourceSnapshotSha256: input.sourceSnapshotSha256,
      });
    }
    const after = await this.panelAuthority();
    if (!after.access.capabilities.fullSnapshot ||
        JSON.stringify(before.revision) !== JSON.stringify(after.revision))
      throw new PanelError("SNAPSHOT_CHANGED", "Records or access changed. Reload SHAMROCK.", 409);
    return result;
  }
  async page(input) {
    if (
      !input ||
      !["full", "scoped"].includes(input.surface) ||
      typeof input.section !== "string" ||
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0
    )
      throw new PanelError("INVALID_REQUEST", "This page is unavailable.");
    if (this.preview) {
      if (input.sections !== undefined)
        throw new PanelError("INVALID_REQUEST", "Reload the selected view.");
      return this.previewPage(input.surface === "full" ? "snapshot" : "panel", {
        section:input.section,offset:input.offset,revision:input.revision,
      }, input.viewRevision ?? null);
    }
    if (input.surface === "scoped") {
      if (input.section === "manifest" && input.revision === null) {
        const authority = await this.panelAuthority();
        if (JSON.stringify(authority.revision) !== JSON.stringify(input.accessRevision))
          throw new PanelError("SNAPSHOT_CHANGED", "Access changed. Reload SHAMROCK.", 409);
      } else if (
        JSON.stringify(input.revision) !== JSON.stringify(input.accessRevision)
      )
        throw new PanelError(
          "SNAPSHOT_CHANGED",
          "Access changed. Reload SHAMROCK.",
          409,
        );
      return this.post("/v1/admin/panel/page", {
        ...this.identity(),
        section: input.section,
        offset: input.offset,
        revision: input.revision,
        ...(input.sections === undefined ? {} : { sections: input.sections }),
      });
    }
    const manifest = await this.panelAuthority();
    if (!manifest.access.capabilities.fullSnapshot)
      throw new PanelError(
        "FORBIDDEN",
        "This page is outside your access.",
        403,
      );
    if (
      JSON.stringify(manifest.revision) !== JSON.stringify(input.accessRevision)
    )
      throw new PanelError(
        "SNAPSHOT_CHANGED",
        "Records or access changed. Reload SHAMROCK.",
        409,
      );
    const page = await this.post("/v1/admin/snapshot/page", {
      ...this.identity(),
      section: input.section,
      offset: input.offset,
      revision: input.revision,
      ...(input.sections === undefined ? {} : { sections: input.sections }),
    });
    const verified = await this.panelAuthority();
    if (
      !verified.access.capabilities.fullSnapshot ||
      JSON.stringify(verified.revision) !== JSON.stringify(input.accessRevision)
    )
      throw new PanelError(
        "SNAPSHOT_CHANGED",
        "Records or access changed. Reload SHAMROCK.",
        409,
      );
    return page;
  }
}
