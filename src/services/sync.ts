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

    // Data Legend is sometimes customized by operators with self-referential dropdown validations
    // (e.g., A3 has validation "from a range" = Data Legend!A3:A). If we clear values and
    // re-write them while the validation is active, Sheets can reject the first write because
    // the allowed-range is temporarily empty.
    if (frontendSheetName === 'Data Legend') {
      try {
        const maxRows = frontendSheet.getMaxRows();
        const lastCol = Math.max(1, frontendSheet.getLastColumn());
        const hasDataArea = maxRows >= 3;
        const dataRow = 3;
        const dataRowCount = Math.max(1, maxRows - 2);

        const validationsByCol: Array<GoogleAppsScript.Spreadsheet.DataValidation | null> = [];
        if (hasDataArea) {
          for (let c = 1; c <= lastCol; c++) {
            validationsByCol.push(frontendSheet.getRange(dataRow, c).getDataValidation());
          }
          frontendSheet.getRange(dataRow, 1, dataRowCount, lastCol).clearDataValidations();
        }

        SheetUtils.writeTable(frontendSheet, data.rows);

        // Restore validations (column-level) after content is present.
        if (hasDataArea) {
          validationsByCol.forEach((dv, idx) => {
            if (!dv) return;
            try {
              frontendSheet.getRange(dataRow, idx + 1, dataRowCount, 1).setDataValidation(dv);
            } catch (err) {
              Log.warn(`Unable to restore Data Legend validation for col=${idx + 1}: ${err}`);
            }
          });
        }
        return;
      } catch (err) {
        Log.warn(`Data Legend sync encountered validation issues; falling back to plain write. Error: ${err}`);
      }
    }

    SheetUtils.writeTable(frontendSheet, data.rows);
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
