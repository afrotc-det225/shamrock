import { createHash, createHmac } from "node:crypto";
import { PanelError } from "../errors.mjs";
import { boundedJson } from "./http.mjs";
const paths = new Set([
  "/v1/admin/history/list",
  "/v1/admin/history/page",
  "/v1/admin/snapshot/page",
  "/v1/admin/panel/page",
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
  constructor(env, principalId) {
    const origin = new URL(env.BACKEND_ORIGIN);
    if (
      env.ENVIRONMENT !== "staging" ||
      !origin.hostname.includes("staging") ||
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
    this.principalId = principalId;
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
    const result = await boundedJson(response, 150000);
    if (!response.ok)
      throw new PanelError(
        result.error?.code || "BACKEND_ERROR",
        result.error?.message || "The operation could not be completed.",
        response.status,
      );
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
    const manifest = await this.panelManifest();
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
  panelManifest() {
    return this.post("/v1/admin/panel/page", {
      ...this.identity(),
      section: "manifest",
      offset: 0,
      revision: null,
    });
  }
  async historyPage(input) {
    const before = await this.panelManifest();
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
    const after = await this.panelManifest();
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
    if (input.surface === "scoped") {
      if (
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
      });
    }
    const manifest = await this.panelManifest();
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
    });
    const verified = await this.panelManifest();
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
