import { panelSnapshotToReportingInput } from "../../../packages/domain/src/panel-read";
import { buildFrontendReporting } from "../../../packages/domain/src/frontend-reporting";
import { snapshotToFrontendReportingInput } from "../../google-adapter/src/frontend-publication";

// Display-only projections use the exact shared rules. Commands still receive
// fresh server-side authorization, validation and optimistic version checks.
export function hydrateReporting(data) {
  if (data.reporting) return data;
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Indiana/Indianapolis",
  }).format(new Date(data.reportingTime));
  return {
    ...data,
    reporting: buildFrontendReporting(
      data.snapshot.contractVersion === "panel-snapshot-v1"
        ? panelSnapshotToReportingInput(data.snapshot, date)
        : snapshotToFrontendReportingInput(data.snapshot, date),
    ),
  };
}
