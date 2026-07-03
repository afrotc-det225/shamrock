// Sync helpers to mirror backend tables to frontend counterparts where schemas align.

namespace SyncService {
  const MAPPINGS: { backend: string; frontend: string }[] = [
    { backend: 'Leadership Backend', frontend: 'Leadership' },
    { backend: 'Data Legend', frontend: 'Data Legend' },
  ];

  function copyTable(backendSheetName: string, frontendSheetName: string) {
    const backendId = Config.getBackendId();
    const frontendId = Config.getFrontendId();
    if (!backendId || !frontendId) return;
    const backendSheet = SheetUtils.getSheet(backendId, backendSheetName);
    const frontendSheet = SheetUtils.getSheet(frontendId, frontendSheetName);
    if (!backendSheet || !frontendSheet) return;
    const data = SheetUtils.readTable(backendSheet);
    SheetUtils.ensureSchemaColumns(frontendSheet);

    // Data Legend drives downstream dropdowns and must not preserve stale self-validations
    // after schema changes. Rebuild the values from the backend and leave validations to
    // the consuming sheets.
    if (frontendSheetName === 'Data Legend') {
      try {
        const maxRows = frontendSheet.getMaxRows();
        const lastCol = Math.max(1, frontendSheet.getLastColumn());
        const dataRowCount = Math.max(1, maxRows - 2);
        frontendSheet.getRange(3, 1, dataRowCount, lastCol).clearDataValidations();
        SheetUtils.writeTable(frontendSheet, data.rows, { clearDataValidationsBeforeWrite: true, trimBlankRows: true });
        return;
      } catch (err) {
        Log.warn(`Data Legend sync encountered validation issues; falling back to plain write. Error: ${err}`);
      }
    }

    SheetUtils.writeTable(frontendSheet, data.rows, { trimBlankRows: true });
  }

  export function syncByBackendSheetName(name: string) {
    if (name === 'Directory Backend') {
      DirectoryService.syncLeadershipBackendFromDirectory();
      DirectoryService.syncDirectoryFrontend();
      return;
    }
    if (name === 'Leadership Backend') {
      DirectoryService.syncLeadershipBackendFromDirectory();
    }
    const mapping = MAPPINGS.find((m) => m.backend === name);
    if (!mapping) return;
    copyTable(mapping.backend, mapping.frontend);
  }

  export function syncAllMapped() {
    DirectoryService.syncLeadershipBackendFromDirectory();
    DirectoryService.syncDirectoryFrontend();
    MAPPINGS.forEach((m) => copyTable(m.backend, m.frontend));
  }
}
