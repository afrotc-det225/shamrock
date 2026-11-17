import { buildFrontendReporting } from '../../../packages/domain/src/frontend-reporting';
import { snapshotToFrontendReportingInput } from '../../google-adapter/src/frontend-publication';

// Display-only projections use the exact shared rules. Commands still receive
// fresh server-side authorization, validation and optimistic version checks.
export function hydrateReporting(data) {
  if (data.reporting) return data;
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Indiana/Indianapolis',
  }).format(new Date(data.reportingTime));
  return {
    ...data,
    reporting: buildFrontendReporting(snapshotToFrontendReportingInput(data.snapshot, date)),
  };
}
