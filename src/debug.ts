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

  interface SourceNames {
    spreadsheets: Map<string, string | null>;
    forms: Map<string, string | null>;
  }

  function describeSpreadsheet(id: string, names: SourceNames): SheetSummary[] {
    if (!id) return [];
    const ss = SpreadsheetApp.openById(id);
    names.spreadsheets.set(id, ss.getName());
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

  function describeForms(names: SourceNames): FormSummary[] {
    const ids = [
      Config.getScriptProperty(Config.PROPERTY_KEYS.ATTENDANCE_FORM_ID),
      Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_REQUEST_FORM_ID),
      Config.getScriptProperty(Config.PROPERTY_KEYS.CADET_DIRECTORY_FORM_ID),
    ].filter(Boolean) as string[];

    return ids.map((id) => {
      const f = FormApp.openById(id);
      const title = f.getTitle();
      names.forms.set(id, title);
      let destinationId: string | null = null;
      try {
        destinationId = (f as any).getDestinationId?.() || null;
      } catch (err) {
        destinationId = null;
      }
      return {
        title,
        id,
        destinationId,
      };
    });
  }

  function describeTriggers(names: SourceNames): TriggerSummary[] {
    const triggers = ScriptApp.getProjectTriggers();
    const frontendId = Config.getFrontendId();
    const backendId = Config.getBackendId();

    const resolveSourceName = (id: string | null, source: GoogleAppsScript.Script.TriggerSource | null): string | null => {
      if (!id) return null;
      // Form IDs must never be passed to SpreadsheetApp. Clock and other
      // non-Sheets/Form sources do not need a file lookup for this diagnostic.
      const isSpreadsheet = source === ScriptApp.TriggerSource.SPREADSHEETS;
      const isForm = source === ScriptApp.TriggerSource.FORMS;
      if (!isSpreadsheet && !isForm) return null;
      const cache = isSpreadsheet ? names.spreadsheets : names.forms;
      if (cache.has(id)) return cache.get(id)!;
      let name: string | null = null;
      try {
        name = isSpreadsheet ? SpreadsheetApp.openById(id).getName() : FormApp.openById(id).getTitle();
      } catch {
        Log.warn('Unable to resolve a trigger source name; the diagnostic will leave it blank.');
      }
      cache.set(id, name);
      return name;
    };

    return triggers.map((t) => {
      let source: GoogleAppsScript.Script.TriggerSource | null = null;
      try {
        source = t.getTriggerSource();
      } catch {
        // An unavailable source type must not be guessed from its ID.
      }
      let type = 'UNKNOWN';
      try {
        type = String((t as any).getEventType?.() ?? source ?? 'UNKNOWN');
      } catch {
        // ignore
      }
      let sourceId: string | null = null;
      try {
        sourceId = t.getTriggerSourceId ? (t.getTriggerSourceId() as any) : null;
      } catch {
        sourceId = null;
      }
      const sourceName = resolveSourceName(sourceId, source) || (source === ScriptApp.TriggerSource.SPREADSHEETS
        ? sourceId === frontendId ? 'FRONTEND (by id match)' : sourceId === backendId ? 'BACKEND (by id match)' : null
        : null);
      return {
        handler: t.getHandlerFunction(),
        type,
        sourceId: sourceId || null,
        sourceName,
      } as TriggerSummary;
    });
  }

  function structureSnapshot() {
    const frontendId = Config.getFrontendId();
    const backendId = Config.getBackendId();
    const names: SourceNames = { spreadsheets: new Map(), forms: new Map() };
    return {
      frontend: describeSpreadsheet(frontendId, names),
      backend: describeSpreadsheet(backendId, names),
      forms: describeForms(names),
      triggers: describeTriggers(names),
    };
  }

  export function dumpShamrockStructure(): void {
    const payload = structureSnapshot();
    Logger.log(JSON.stringify(payload, null, 2));
  }

  export function dumpShamrockStructureToDrive(): void {
    const payload = {
      ...structureSnapshot(),
      generated_at: new Date().toISOString(),
    };
    const blob = Utilities.newBlob(JSON.stringify(payload, null, 2), 'application/json', `shamrock-structure-${Date.now()}.json`);
    const file = DriveApp.createFile(blob);
    Logger.log(`Structure snapshot written to Drive: ${file.getName()} (ID: ${file.getId()})`);
  }
}
