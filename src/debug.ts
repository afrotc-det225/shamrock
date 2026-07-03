// Debug helpers to inspect current SHAMROCK state.

namespace Debug {
  interface SheetSummary {
    sheet: string;
    headers_row1: any[];
    headers_row2: any[];
    rows: number;
    cols: number;
  }

  interface FormSummary {
    title: string;
    id: string;
    destinationId: string | null;
  }

  interface TriggerSummary {
    handler: string;
    type: string;
    sourceId: string | null;
    sourceName: string | null;
  }

  function describeSpreadsheet(id: string): SheetSummary[] {
    if (!id) return [];
    const ss = SpreadsheetApp.openById(id);
    return ss.getSheets().map((s) => {
      const cols = Math.max(1, s.getLastColumn());
      const headers = s.getRange(1, 1, 2, cols).getValues();
      return {
        sheet: s.getName(),
        headers_row1: headers[0],
        headers_row2: headers[1],
        rows: s.getLastRow(),
        cols: s.getLastColumn(),
      };
    });
  }

  function describeForms(): FormSummary[] {
    const ids = [
      Config.getScriptProperty(Config.PROPERTY_KEYS.ATTENDANCE_FORM_ID),
      Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_REQUEST_FORM_ID),
      Config.getScriptProperty(Config.PROPERTY_KEYS.CADET_DIRECTORY_FORM_ID),
    ].filter(Boolean) as string[];

    return ids.map((id) => {
      const f = FormApp.openById(id);
      let destinationId: string | null = null;
      try {
        destinationId = (f as any).getDestinationId?.() || null;
      } catch (err) {
        destinationId = null;
      }
      return {
        title: f.getTitle(),
        id,
        destinationId,
      };
    });
  }

  function describeTriggers(): TriggerSummary[] {
    const triggers = ScriptApp.getProjectTriggers();
    const frontendId = Config.getFrontendId();
    const backendId = Config.getBackendId();

    const resolveSheetName = (id: string | null): string | null => {
      if (!id) return null;
      try {
        return SpreadsheetApp.openById(id).getName();
      } catch (err) {
        Log.warn(`Unable to resolve sheet name for id=${id}: ${err}`);
        return null;
      }
    };

    return triggers.map((t) => {
      let type = 'UNKNOWN';
      try {
        type = String((t as any).getEventType?.() || t.getTriggerSource());
      } catch {
        // ignore
      }
      let sourceId: string | null = null;
      try {
        sourceId = t.getTriggerSourceId ? (t.getTriggerSourceId() as any) : null;
      } catch {
        sourceId = null;
      }
      const sourceName = resolveSheetName(sourceId) || (sourceId === frontendId ? 'FRONTEND (by id match)' : sourceId === backendId ? 'BACKEND (by id match)' : null);
      return {
        handler: t.getHandlerFunction(),
        type,
        sourceId: sourceId || null,
        sourceName,
      } as TriggerSummary;
    });
  }

  export function dumpShamrockStructure(): void {
    const frontendId = Config.getFrontendId();
    const backendId = Config.getBackendId();
    const payload = {
      frontend: describeSpreadsheet(frontendId),
      backend: describeSpreadsheet(backendId),
      forms: describeForms(),
      triggers: describeTriggers(),
    };
    Logger.log(JSON.stringify(payload, null, 2));
  }

  export function dumpShamrockStructureToDrive(): void {
    const frontendId = Config.getFrontendId();
    const backendId = Config.getBackendId();
    const payload = {
      frontend: describeSpreadsheet(frontendId),
      backend: describeSpreadsheet(backendId),
      forms: describeForms(),
      triggers: describeTriggers(),
      generated_at: new Date().toISOString(),
    };
    const blob = Utilities.newBlob(JSON.stringify(payload, null, 2), 'application/json', `shamrock-structure-${Date.now()}.json`);
    const file = DriveApp.createFile(blob);
    Logger.log(`Structure snapshot written to Drive: ${file.getName()} (ID: ${file.getId()})`);
  }
}
