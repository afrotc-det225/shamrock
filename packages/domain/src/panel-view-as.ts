import type { FrontendSnapshot } from './admin.js';
import type { PanelAccess } from './panel-read.js';

export const PANEL_VIEW_AS_PAGE_MAX_BYTES = 130048;
export type PanelViewAsStatus = 'ready' | 'no-active-principal' | 'ambiguous-principal' | 'no-verified-login' | 'no-panel-access';
export interface PanelViewAsAuthorization {
    directoryWorkspace?: boolean;
  contractVersion: 'panel-view-as-v1'; readOnly: true;
  action: 'enter' | 'exit'; entryAuditId: string;
  targetPersonId: string; targetPrincipalId: string | null;
  status: PanelViewAsStatus | 'exited'; access: PanelAccess | null;
}
export type PanelViewAsKind = 'panel' | 'snapshot' | 'history' | 'history-list';
/** The original target response stays intact; preview identity is a separate, mandatory envelope. */
export interface PanelViewAsPage {
  contractVersion: 'panel-view-as-page-v1'; readOnly: true;
  environment: FrontendSnapshot['environment']; generation: number;
  entryAuditId: string; targetPersonId: string; targetPrincipalId: string;
  viewRevision: string; kind: PanelViewAsKind; page: unknown;
}
