import { createHash, createHmac } from "node:crypto";
import { captureOperationalSnapshot } from "../../../scripts/lib/operational-admin.mjs";
import { PanelError } from "../errors.mjs";
import { boundedJson } from "./http.mjs";
const paths = new Set([
  "/v1/admin/snapshot/page",
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
    if (++this.calls > 40)
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
  snapshot() {
    return captureOperationalSnapshot(this.identity(), async (path, input) => ({
      status: 200,
      body: await this.post(path, input),
    }));
  }
}
