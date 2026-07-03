// Append-only audit logging helpers for operator actions and automation events.

namespace AuditService {
  export type AuditResult = 'started' | 'ok' | 'failed' | 'cancelled' | 'skipped';

  export interface AuditEntry {
    action: string;
    result: AuditResult | string;
    actionLabel?: string;
    category?: string;
    actorEmail?: string;
    role?: string;
    targetSheet?: string;
    targetTable?: string;
    targetKey?: string;
    targetRange?: string;
    eventId?: string;
    requestId?: string;
    field?: string;
    oldValue?: any;
    newValue?: any;
    reason?: string;
    notes?: string;
    source?: string;
    version?: string;
    runId?: string;
    durationMs?: number;
    severity?: 'INFO' | 'WARN' | 'ERROR';
    error?: any;
    metadata?: Record<string, any>;
    backendId?: string;
  }

  function safeString(value: any, maxLength = 5000): string {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'string' ? value : String(value);
    return text.length > maxLength ? `${text.substring(0, maxLength)}... [truncated]` : text;
  }

  function errorMessage(error: any): string {
    if (!error) return '';
    if (error instanceof Error) return error.message || String(error);
    return safeString(error);
  }

  function errorStack(error: any): string {
    if (!error) return '';
    if (error instanceof Error && error.stack) return safeString(error.stack, 20000);
    return '';
  }

  function safeJson(value: any): string {
    if (!value) return '';
    try {
      return safeString(JSON.stringify(value), 20000);
    } catch (err) {
      return safeString(`Unable to serialize metadata: ${err}`);
    }
  }

  export function actorEmail(): string {
    try {
      const active = Session.getActiveUser().getEmail();
      if (active) return active.toLowerCase();
    } catch (err) {
      Log.warn(`Unable to read active user email for audit: ${err}`);
    }
    return 'unknown';
  }

  export function actorKey(): string {
    try {
      return Session.getTemporaryActiveUserKey() || '';
    } catch {
      return '';
    }
  }

  function activeSpreadsheetContext(): { spreadsheetId: string; spreadsheetName: string } {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      return {
        spreadsheetId: ss?.getId?.() || '',
        spreadsheetName: ss?.getName?.() || '',
      };
    } catch {
      return { spreadsheetId: '', spreadsheetName: '' };
    }
  }

  export function log(entry: AuditEntry): void {
    try {
      const backendId = entry.backendId || Config.getBackendId();
      if (!backendId) {
        Log.warn(`Audit skipped for action=${entry.action}: backend spreadsheet ID missing.`);
        return;
      }

      const auditSheet = SheetUtils.getSheet(backendId, 'Audit Backend');
      if (!auditSheet) {
        Log.warn(`Audit skipped for action=${entry.action}: Audit Backend sheet not found.`);
        return;
      }

      const headers = SheetUtils.ensureSchemaColumns(auditSheet);
      const context = activeSpreadsheetContext();
      const row: Record<string, any> = {};
      headers.forEach((h) => (row[h] = ''));

      row['audit_id'] = Utilities.getUuid();
      row['timestamp'] = new Date();
      row['actor_email'] = entry.actorEmail || actorEmail();
      row['actor_key'] = actorKey();
      row['role'] = entry.role || 'operator';
      row['action'] = entry.action;
      row['action_label'] = entry.actionLabel || '';
      row['category'] = entry.category || '';
      row['target_sheet'] = entry.targetSheet || '';
      row['target_table'] = entry.targetTable || '';
      row['target_key'] = entry.targetKey || '';
      row['target_range'] = entry.targetRange || '';
      row['event_id'] = entry.eventId || '';
      row['request_id'] = entry.requestId || '';
      row['field'] = entry.field || '';
      row['old_value'] = safeString(entry.oldValue);
      row['new_value'] = safeString(entry.newValue);
      row['result'] = entry.result || '';
      row['reason'] = entry.reason || '';
      row['notes'] = entry.notes || '';
      row['source'] = entry.source || 'AuditService';
      row['version'] = entry.version || 'v2';
      row['run_id'] = entry.runId || '';
      row['duration_ms'] = entry.durationMs ?? '';
      row['severity'] = entry.severity || (entry.result === 'failed' ? 'ERROR' : 'INFO');
      row['error_message'] = errorMessage(entry.error);
      row['error_stack'] = errorStack(entry.error);
      row['metadata_json'] = safeJson(entry.metadata);
      row['spreadsheet_id'] = context.spreadsheetId;
      row['spreadsheet_name'] = context.spreadsheetName;

      SheetUtils.appendRows(auditSheet, [row]);
    } catch (err) {
      Log.warn(`Audit logging failed for action=${entry.action}: ${err}`);
    }
  }
}
