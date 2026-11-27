import { createHash } from "node:crypto";
import { REPORTING_POLICY_VERSION } from "../../../packages/domain/src/frontend-reporting.ts";
import { PanelError } from "../errors.mjs";
import { historyChartsKey } from "../history-table.mjs";
import { browseState } from "./browse.mjs";
import { decodeBrowse } from "../src/browse.js";

// fullSnapshot is the Wing-wide read grant. Commands, identities and scoped data
// never enter this cache. Bump the schema when attendance reporting rules change.
export function currentChartsKey(backend, authority) {
  const identity = [
    REPORTING_POLICY_VERSION,
    backend.env.BACKEND_ORIGIN,
    backend.generation,
    authority.scope,
    authority.revision.operations,
    authority.revision.administration,
  ];
  return (
    "overview/v2/" +
    createHash("sha256").update(JSON.stringify(identity)).digest("hex")
  );
}

export function chartFields(dashboard) {
  const {
    averageOverall,
    averageLlab,
    belowEighty,
    gmcCadets,
    pocCadets,
    noCountedAttendanceCadets,
    attendanceByYear,
    attendanceByFlight,
    rosterByYear,
  } = dashboard;
  return {
    averageOverall,
    averageLlab,
    belowEighty,
    gmcCadets,
    pocCadets,
    noCountedAttendanceCadets,
    attendanceByYear,
    attendanceByFlight,
    rosterByYear,
  };
}

const recent = new Map();
const pending = new Map();
async function currentDashboard(backend, authority, key) {
  const cached = recent.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  if (pending.has(key)) return pending.get(key);
  const compile = async () => {
    const store = backend.env.HISTORY_FILES;
    let value = await store?.get(key, "json");
    if (!value) {
      const browse = await browseState(backend, authority, "attendance");
      const { reporting,list } = await decodeBrowse({
        browse,
        manifest: authority,
        reportingTime: Date.now(),
      });
      value = {...chartFields(reporting.dashboard),termLabel:list?.terms?.find(t=>t.isCurrent)?.label ?? null};
      // Cache failure must not prevent delivery of an already compiled report.
      if (store) {
        try {
          await store.put(key, JSON.stringify(value), {
            expirationTtl: 604800,
          });
        } catch {
          /* The isolate still reuses the revision below. */
        }
      }
    }
    if (recent.size >= 8) recent.delete(recent.keys().next().value);
    recent.set(key, { value, until: Date.now() + 300000 });
    return value;
  };
  const result = compile();
  pending.set(key, result);
  try {
    return await result;
  } finally {
    pending.delete(key);
  }
}

export async function wingCharts(backend) {
  const authority = await backend.panelAuthority();
  if (!authority.access.capabilities.fullSnapshot)
    throw new PanelError(
      "FORBIDDEN",
      "Wing attendance is outside your access.",
      403,
    );
  const key = currentChartsKey(backend, authority);
  const viewRevision = backend.viewRevision;
  const [dashboard, history] = await Promise.all([
    currentDashboard(backend, authority, key),
    backend.env.HISTORY_FILES?.get(
      historyChartsKey(backend.generation),
      "json",
    ),
  ]);
  const after = await backend.panelAuthority();
  if (
    !after.access.capabilities.fullSnapshot ||
    currentChartsKey(backend, after) !== key ||
    authority.revision.access !== after.revision.access ||
    viewRevision !== backend.viewRevision
  )
    throw new PanelError(
      "SNAPSHOT_CHANGED",
      "Records or access changed. Reload Overview.",
      409,
    );
  return {
    dashboard,
    history: history ?? [],
    awaitingHistory: backend.dataset === "real" && history == null,
    captureKey: backend.binding,
    revision: authority.revision,
    viewAsRevision: viewRevision,
  };
}
