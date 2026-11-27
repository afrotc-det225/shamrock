import { flightRoleOptions } from "../../../packages/domain/src/flight-roles.js";
import { flightRolePolicy } from "./permissions.js";
import { HttpError } from "./http-error.js";
import type { CadetEnv } from "./cadet-workspace.js";

type Guard = { sql: string; values: (string | number | null)[] };
type Target = { personId: unknown; role: unknown; version: unknown };
export async function assignFlightRole(
  env: CadetEnv,
  guard: Guard,
  actor: string,
  commandId: string,
  flightId: string,
  flight: string,
  target: Target,
  fields: Record<string, unknown>,
) {
  const options = ["", ...flightRoleOptions(flight)];
  const version = fields.version,
    role = fields.role,
    id = String(target.personId);
  if (
    typeof role !== "string" ||
    !options.includes(role) ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    throw new HttpError(400, "INVALID_ROLE", "Choose a Flight role.");
  const db = env.DB,
    now = new Date().toISOString(),
    operation = "directory.flightRole";
  const receipt = {
    commandId,
    status: "committed",
    result: { targetId: id, version: version + 1 },
  };
  const signature = JSON.stringify([actor, id, flightId, version, role]);
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(signature),
      ),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
  const replay = async () =>
    (await db
      .prepare(
        "SELECT 1 AS ok FROM admin_commands WHERE command_id=? AND operation=? AND payload_hash=?",
      )
      .bind(commandId, operation, hash)
      .first()) !== null;
  if (await replay()) return receipt;
  if (!options.includes(String(target.role)) || target.version !== version)
    throw new HttpError(
      409,
      "ROLE_CHANGED",
      "Reload the roster. Existing command and combined positions require a Directory manager.",
    );
  const policy = await flightRolePolicy(
    env,
    id,
    String(target.role),
    version,
    role,
    commandId,
    actor,
    now,
  );
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO command_assertions VALUES(?,(${guard.sql}) AND (${policy.assertion.sql})
        AND EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment=? AND generation=? AND accepting_commands=1)
        AND EXISTS(SELECT 1 FROM adapter_sources WHERE source_kind='test' AND resource_key='admin-staging-web' AND active=1)
        AND EXISTS(SELECT 1 FROM directory_profiles d JOIN memberships m ON m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1
          WHERE d.person_id=? AND d.version=? AND d.role=? AND d.flight_id=? AND d.flight_path_status NOT IN ('Inactive','Dropped','Commissioned')))`,
        )
        .bind(
          commandId,
          ...guard.values,
          ...policy.assertion.values,
          env.ENVIRONMENT,
          Number(env.GENERATION),
          id,
          version,
          target.role,
          flightId,
        ),
      db
        .prepare("INSERT INTO command_registry VALUES(?,'admin')")
        .bind(commandId),
      db
        .prepare(
          "INSERT INTO admin_commands VALUES(?,?,?,?,?,'flight.role',?,'test','admin-staging-web',?,1,?,?)",
        )
        .bind(
          commandId,
          hash,
          actor,
          operation,
          id,
          JSON.stringify([flightId]),
          commandId,
          now,
          JSON.stringify(receipt),
        ),
      db
        .prepare(
          "UPDATE directory_profiles SET role=?,version=version+1,updated_at=? WHERE person_id=?",
        )
        .bind(role, now, id),
      ...policy.writes,
      db
        .prepare(
          "INSERT INTO admin_audit_events(command_id,actor_id,actor_evidence,operation,target_id,accepted_at,before_json,after_json) VALUES(?,?,'authenticated-confirmation',?,?,?,?,?)",
        )
        .bind(
          commandId,
          actor,
          operation,
          id,
          now,
          JSON.stringify({ role: target.role }),
          JSON.stringify({ role }),
        ),
      db
        .prepare(
          "INSERT INTO admin_effects(effect_id,command_id,kind,state,created_at) VALUES(?,?,'frontend.refresh','pending',?)",
        )
        .bind(crypto.randomUUID(), commandId, now),
      db
        .prepare("DELETE FROM command_assertions WHERE command_id=?")
        .bind(commandId),
    ]);
  } catch {
    if (!(await replay()))
      throw new HttpError(
        409,
        "ROLE_CHANGED",
        "The assignment changed. Reload the Flight roster.",
      );
  }
  return receipt;
}
