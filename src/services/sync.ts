// Sync helpers to mirror backend tables to frontend counterparts where schemas align.

namespace SyncService {
  const MAPPINGS: { backend: string; frontend: string }[] = [
    { backend: 'Leadership Backend', frontend: 'Leadership' },
    { backend: 'Data Legend', frontend: 'Data Legend' },
  ];

  function withStorageReadRetry<T>(
    label: string,
    operation: () => T,
  ): T {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return operation();
      } catch (err) {
        const message = String(err || '').toLowerCase();
        const isStoragePermissionError = message.includes('reading from storage') || message.includes('permission_denied');
        if (!isStoragePermissionError || attempt === maxAttempts) throw err;
        Log.warn(`${label}: transient storage read failed; retrying attempt ${attempt + 1}/${maxAttempts}. Error: ${err}`);
        SpreadsheetApp.flush();
        Utilities.sleep(400 * attempt);
      }
    }
    throw new Error(`${label}: unable to read table after ${maxAttempts} attempts.`);
  }

  function copyTable(backendSheetName: string, frontendSheetName: string) {
    const backendId = Config.getBackendId();
    const frontendId = Config.getFrontendId();
    if (!backendId || !frontendId) return;
    const backendSheet = SheetUtils.getSheet(backendId, backendSheetName);
    const frontendSheet = SheetUtils.getSheet(frontendId, frontendSheetName);
    if (!backendSheet || !frontendSheet) return;
    const data = withStorageReadRetry(
      `${backendSheetName} -> ${frontendSheetName}`,
      () => SheetUtils.readTable(backendSheet),
    );
    withStorageReadRetry(
      `${frontendSheetName} schema preparation`,
      () => SheetUtils.ensureSchemaColumns(frontendSheet),
    );

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

    withStorageReadRetry(
      `${frontendSheetName} table write`,
      () => SheetUtils.writeTable(frontendSheet, data.rows, { trimBlankRows: true }),
    );
  }

  export function syncByBackendSheetName(name: string) {
    if (name === 'Directory Backend') {
      DirectoryService.syncLeadershipBackendFromDirectory();
      DirectoryService.syncDirectoryFrontend();
      return;
    }
    if (name === 'Leadership Backend') {
      Log.info('Leadership sync: deriving backend rows from Directory.');
      withStorageReadRetry(
        'Leadership sync backend derivation',
        () => DirectoryService.syncLeadershipBackendFromDirectory(),
      );
      SpreadsheetApp.flush();
      Log.info('Leadership sync: backend write flushed; mirroring to frontend.');
    }
    const mapping = MAPPINGS.find((m) => m.backend === name);
    if (!mapping) return;
    copyTable(mapping.backend, mapping.frontend);
  }

  export function syncAllMapped() {
    withStorageReadRetry(
      'Sync all mapped backend Leadership derivation',
      () => DirectoryService.syncLeadershipBackendFromDirectory(),
    );
    DirectoryService.syncDirectoryFrontend();
    SpreadsheetApp.flush();
    MAPPINGS.forEach((m) => copyTable(m.backend, m.frontend));
  }
}
