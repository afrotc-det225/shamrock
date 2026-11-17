import { createHash, createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Miniflare, Log, LogLevel } from "miniflare";
import { initializeLocalDatabase } from "../../scripts/lib/v3-local-database.mjs";
import { captureOperationalSnapshot } from "../../.build/admin/domain.mjs";

import { PanelError } from "./errors.mjs";
export { PanelError } from "./errors.mjs";
export const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class Backend {
  constructor({
    environment,
    generation,
    keyId,
    secret,
    baseUrl,
    principalId,
    sourceResource,
    fetcher = fetch,
  }) {
    if (
      !["local", "staging"].includes(environment) ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !secret ||
      secret.length < 32
    )
      throw new Error("Invalid isolated backend configuration");
    const url = new URL(baseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("Use an HTTPS backend origin");
    if (environment === "staging" && !url.hostname.includes("staging"))
      throw new Error("Only explicitly named staging hosts are supported");
    Object.assign(this, {
      environment,
      generation,
      keyId,
      secret,
      baseUrl: url.origin,
      principalId,
      sourceResource,
      fetcher,
    });
    this.binding = hash({
      environment,
      generation,
      baseUrl: url.origin,
      principalId,
      sourceResource,
      keyId,
    });
  }
  identity() {
    return {
      environment: this.environment,
      generation: this.generation,
      principalId: this.principalId,
    };
  }
  envelope(operation, payload, commandId) {
    return {
      contractVersion: 1,
      environment: this.environment,
      generation: this.generation,
      commandId,
      actor: {
        principalId: this.principalId,
        evidence: "authenticated-confirmation",
      },
      source: {
        kind: "test",
        resourceKey: this.sourceResource,
        submissionId: commandId,
        revision: 1,
      },
      operation,
      payload,
    };
  }
  async post(path, input) {
    if (!path.startsWith("/v1/")) throw new Error("Invalid backend route");
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > 65536)
      throw new PanelError("TOO_LARGE", "Please make a smaller change.");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", this.secret)
      .update(
        `POST\n${path}\n${timestamp}\n${createHash("sha256").update(body).digest("hex")}`,
      )
      .digest("hex");
    let response;
    try {
      response = await this.fetcher(this.baseUrl + path, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          "content-type": "application/json",
          "x-shamrock-key-id": this.keyId,
          "x-shamrock-timestamp": timestamp,
          "x-shamrock-signature": signature,
        },
        body,
      });
    } catch {
      throw new PanelError(
        "CONNECTION_INTERRUPTED",
        "The response was interrupted. Retry this same saved change; do not recreate it.",
        503,
      );
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new PanelError(
        "INVALID_RESPONSE",
        "SHAMROCK returned an unreadable response. Retry the saved change.",
        502,
      );
    }
    if (!response.ok)
      throw new PanelError(
        result.error?.code || "BACKEND_ERROR",
        result.error?.message || "This operation could not be completed.",
        response.status,
      );
    return result;
  }
  async snapshot() {
    return captureOperationalSnapshot(this.identity(), async (path, input) => ({
      status: 200,
      body: await this.post(path, input),
    }));
  }
}

export async function createLocalBackend(storagePath) {
  const secret = randomBytes(32).toString("hex");
  const mf = new Miniflare({
    modules: true,
    modulesRoot: fileURLToPath(new URL("../../", import.meta.url)),
    scriptPath: fileURLToPath(
      new URL("../../.build/admin/worker.mjs", import.meta.url),
    ),
    compatibilityDate: "2026-07-01",
    d1Databases: { DB: "shamrock-admin-local" },
    ...(storagePath ? { d1Persist: storagePath } : {}),
    bindings: {
      ENVIRONMENT: "local",
      GENERATION: "1",
      BRIDGE_KEY_ID: "admin-local",
      BRIDGE_SECRET: secret,
    },
    log: new Log(LogLevel.NONE),
  });
  // Exercise real D1 through a loopback fixture route; do not use Miniflare's
  // synchronous binding proxy (which stalls on some local Node runtimes).
  const batch = async (statements) => {
    const response = await mf.dispatchFetch(
      "https://admin-local.invalid/__local_fixture",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fixture-secret": secret,
        },
        body: JSON.stringify({ statements }),
      },
    );
    if (!response.ok)
      throw new Error(`Local fixture failed: ${await response.text()}`);
    const results = await response.json();
    if (results.some((r) => !r.success))
      throw new Error("Local fixture SQL failed");
    return results;
  };
  const prepare = (sql, values = []) => ({
    sql,
    values,
    bind: (...v) => prepare(sql, v),
    all: async () => (await batch([{ sql, values }]))[0],
    first: async (column) => {
      const row = (await batch([{ sql, values }]))[0].results[0] ?? null;
      return column ? (row?.[column] ?? null) : row;
    },
    run: async () => (await batch([{ sql, values }]))[0],
  });
  const db = {
    prepare,
    batch: (statements) =>
      batch(statements.map(({ sql, values }) => ({ sql, values }))),
  };
  const exists = await db
    .prepare("SELECT name FROM sqlite_master WHERE name='system_control'")
    .first();
  const backend = new Backend({
    environment: "local",
    generation: 1,
    keyId: "admin-local",
    secret,
    baseUrl: "https://admin-local.invalid",
    principalId: "panel-owner",
    sourceResource: "admin-panel",
    fetcher: (...args) => mf.dispatchFetch(...args),
  });
  if (!exists) {
    await initializeLocalDatabase(db);
    await db.batch([
      db.prepare("INSERT INTO system_control VALUES(1,'local',1,1)"),
      db.prepare("INSERT INTO principals VALUES('panel-owner',NULL,1)"),
      db.prepare("INSERT INTO adapter_sources VALUES('test','admin-panel',1)"),
      db.prepare(
        "INSERT INTO organizational_units VALUES('alpha','Alpha',1),('bravo','Bravo',1)",
      ),
      db.prepare("INSERT INTO squadrons VALUES('blue','Blue'),('gold','Gold')"),
      db.prepare(
        "INSERT INTO flight_hierarchy VALUES('alpha','blue'),('bravo','gold')",
      ),
      db.prepare("INSERT INTO terms VALUES('fall-2026','Fall 2026',1,1)"),
      db.prepare("INSERT INTO transition_authorities VALUES('panel-owner',1)"),
      db.prepare("INSERT INTO closeout_authorities VALUES('panel-owner',1)"),
      db.prepare(
        'INSERT INTO admin_grants SELECT \'panel-owner\',value,\'wing\',\'*\' FROM json_each(\'["directory.manage","leadership.manage","events.manage","frontend.read","attendance.correct","notifications.manage"]\')',
      ),
      db.prepare(
        "INSERT INTO access_grants VALUES('panel-owner','excusal.decide','alpha','unit'),('panel-owner','excusal.decide','bravo','unit'),('panel-owner','excusal.submit','alpha','unit'),('panel-owner','attendance.report','alpha','unit')",
      ),
    ]);
    for (const [index, firstName, lastName, asYear, flightId] of [
      [1, "Alex", "Morgan", "AS400", "alpha"],
      [2, "Jordan", "Reed", "AS300", "alpha"],
      [3, "Casey", "Brooks", "AS200", "bravo"],
      [4, "Taylor", "Hayes", "AS100", "bravo"],
    ]) {
      const profile = {
        firstName,
        lastName,
        asYear,
        rank: asYear === "AS400" || asYear === "AS300" ? "C/2d Lt" : "C/3C",
        role: index === 2 ? "Flight Commander" : "",
        university: "Notre Dame",
        email: `cadet${index}@example.invalid`,
        phone: "",
        dorm: "",
        cipBroadArea: "",
        cipCode: "",
        afsc: "",
        homeTown: "",
        homeState: "",
        classYear: "",
        dateOfBirth: null,
        flightPathStatus: "Active 3/4",
        photoLink: "",
      };
      await backend.post(
        "/v1/admin/commands",
        backend.envelope(
          "directory.upsert",
          { personId: `cadet-${index}`, expectedVersion: 0, flightId, profile },
          `seed-person-${index}`,
        ),
      );
    }
    const events = [
      ["tw12-mando", "TW-12 Mando", "mando", "2026-11-05T11:30:00Z"],
      ["tw12-llab", "TW-12 LLAB", "llab", "2026-11-03T20:30:00Z"],
      ["veterans", "Veterans Day", "other", "2026-11-11T12:00:00Z"],
      ["wolfe", "Wolfe Talk", "other", "2026-11-13T20:00:00Z"],
      ["tw13-mando", "TW-13 Mando", "mando", "2026-11-12T11:30:00Z"],
      ["tw13-llab", "TW-13 LLAB", "llab", "2026-11-10T20:30:00Z"],
    ];
    for (const [
      index,
      [eventId, label, eventType, startAt],
    ] of events.entries()) {
      const payload = {
        eventId,
        expectedVersion: 0,
        termId: "fall-2026",
        eventType,
        trainingWeek: eventType === "other" ? null : index < 2 ? 12 : 13,
        displayOrder: index,
        label,
        columnLabel: label,
        expectedGroup: "All cadets",
        flightIds: ["alpha", "bravo"],
        eligiblePersonIds: ["cadet-1", "cadet-2", "cadet-3", "cadet-4"],
        status: "active",
        startAt: new Date(startAt).toISOString(),
        endAt: new Date(Date.parse(startAt) + 7200000).toISOString(),
        location: "",
        notes:
          eventId === "veterans"
            ? "Practice and ceremony."
            : eventId === "wolfe"
              ? "Mandatory talk."
              : "",
      };
      await backend.post(
        "/v1/admin/commands",
        backend.envelope("event.upsert", payload, `seed-event-${index}`),
      );
    }
    await backend.post(
      "/v1/commands",
      backend.envelope(
        "excusal.submit",
        {
          requestId: "request-demo",
          eventId: "veterans",
          personId: "cadet-1",
          requestedOutcome: "E",
          reason: "Fictional scheduling conflict.",
        },
        "seed-request",
      ),
    );
  }
  return { backend, db, dispose: () => mf.dispose() };
}
