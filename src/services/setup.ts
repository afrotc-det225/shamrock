// Setup service: idempotent provisioning of spreadsheets, sheets, and forms.

namespace SetupService {
  function extractFormIdFromUrl(url: string): string | null {
    if (!url) return null;
    // Common Forms URL formats:
    // - https://docs.google.com/forms/d/e/<ID>/viewform
    // - https://docs.google.com/forms/d/<ID>/edit
    const match = url.match(/\/forms\/d\/(?:e\/)?([a-zA-Z0-9_-]+)/);
    return match?.[1] || null;
  }

  function getFormDestinationSpreadsheetId(form: GoogleAppsScript.Forms.Form): string | null {
    try {
      const anyForm = form as any;
      const destinationType = anyForm.getDestinationType?.();
      const destinationId = anyForm.getDestinationId?.();
      if (destinationType === FormApp.DestinationType.SPREADSHEET && typeof destinationId === 'string') {
        return destinationId;
      }
      return null;
    } catch {
      return null;
    }
  }

  function ensureSpreadsheet(role: Types.WorkbookRole, name: string, propertyKey: string): Types.EnsureSpreadsheetResult {
    Log.info(`Ensuring spreadsheet for role=${role}`);
    const existingId = Config.getScriptProperty(propertyKey);
    let spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet | null = null;
    let created = false;

    if (existingId) {
      try {
        spreadsheet = SpreadsheetApp.openById(existingId);
        Log.info(`Found existing spreadsheet id=${existingId}`);
      } catch (err) {
        Log.warn(`Stored spreadsheet id invalid for key=${propertyKey}; creating new. Error: ${err}`);
      }
    }

    if (!spreadsheet) {
      spreadsheet = SpreadsheetApp.create(name);
      Config.setScriptProperty(propertyKey, spreadsheet.getId());
      created = true;
      Log.info(`Created spreadsheet name=${name} id=${spreadsheet.getId()}`);
    }

    return {
      role,
      id: spreadsheet.getId(),
      name: spreadsheet.getName(),
      created,
      url: spreadsheet.getUrl(),
    };
  }

  function ensureSheet(spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet, schema: Types.TabSchema): Types.EnsureSheetResult {
    const { name, machineHeaders, displayHeaders } = schema;
    Log.info(`Ensuring sheet name=${name} in spreadsheet=${spreadsheet.getId()}`);
    const existingSheet = spreadsheet.getSheetByName(name);
    let sheet = existingSheet;
    let created = false;
    let headersApplied = false;

    if (!sheet) {
      sheet = spreadsheet.insertSheet(name);
      created = true;
      Log.info(`Created sheet name=${name}`);
    }

    if (sheet && machineHeaders && machineHeaders.length > 0) {
      const headerWidth = machineHeaders.length;
      const firstRow = sheet.getRange(1, 1, 1, headerWidth).getValues()[0];
      const secondRow = sheet.getRange(2, 1, 1, headerWidth).getValues()[0];
      const firstRowEmpty = firstRow.every((cell) => cell === '' || cell === null);
      const secondRowEmpty = secondRow.every((cell) => cell === '' || cell === null);

      if (firstRowEmpty) {
        sheet.getRange(1, 1, 1, headerWidth).setValues([machineHeaders]);
        headersApplied = true;
        Log.info(`Applied machine headers for ${name}`);
      }

      if (secondRowEmpty) {
        const display = displayHeaders && displayHeaders.length === machineHeaders.length ? displayHeaders : machineHeaders;
        sheet.getRange(2, 1, 1, headerWidth).setValues([display]);
        headersApplied = true;
        Log.info(`Applied display headers for ${name}`);
      }

      if (!headersApplied && firstRowEmpty === false && secondRowEmpty === false) {
        const nonEmptyFirst = sheet.getRange(1, 1, 1, headerWidth).getValues()[0];
        const nonEmptySecond = sheet.getRange(2, 1, 1, headerWidth).getValues()[0];
        const firstBlankCount = nonEmptyFirst.filter((v) => v === '' || v === null).length;
        const secondBlankCount = nonEmptySecond.filter((v) => v === '' || v === null).length;
        Log.warn(`Headers present for ${name}; blanks in row1=${firstBlankCount}/${headerWidth}, row2=${secondBlankCount}/${headerWidth}`);
      }

      // Ensure column count matches schema (add missing columns if schema grew)
      const maxCols = sheet.getMaxColumns();
      if (maxCols < headerWidth) {
        const addCount = headerWidth - maxCols;
        Log.info(`Adding ${addCount} missing columns to ${name} to match schema (${maxCols} -> ${headerWidth})`);
        sheet.insertColumnsAfter(maxCols, addCount);
        // Update headers in the new columns
        const display = displayHeaders && displayHeaders.length === machineHeaders.length ? displayHeaders : machineHeaders;
        sheet.getRange(1, maxCols + 1, 1, addCount).setValues([machineHeaders.slice(maxCols)]);
        sheet.getRange(2, maxCols + 1, 1, addCount).setValues([display.slice(maxCols)]);
        headersApplied = true;
      } else if (maxCols > headerWidth) {
        const deleteCount = maxCols - headerWidth;
        Log.info(`Deleting ${deleteCount} extra columns in ${name} (keeps ${headerWidth})`);
        sheet.deleteColumns(headerWidth + 1, deleteCount);
      }
    }

    return {
      spreadsheetId: spreadsheet.getId(),
      sheetName: name,
      created,
      headersApplied,
    };
  }

  function restoreMissingHeaders(spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet, schemas: Types.TabSchema[]) {
    schemas.forEach((schema) => {
      const { name, machineHeaders, displayHeaders } = schema;
      if (!machineHeaders || machineHeaders.length === 0) {
        Log.warn(`Schema for ${name} is missing machine headers; skipping header restoration.`);
        return;
      }
      const sheet = spreadsheet.getSheetByName(name);
      if (!sheet) {
        Log.warn(`Sheet ${name} not found while restoring headers; skipping.`);
        return;
      }
      const headerWidth = machineHeaders.length;
      const firstRow = sheet.getRange(1, 1, 1, headerWidth).getValues()[0];
      const firstRowEmpty = firstRow.every((cell) => cell === '' || cell === null);
      if (!firstRowEmpty) return;
      const display = displayHeaders && displayHeaders.length === headerWidth ? displayHeaders : machineHeaders;
      sheet.getRange(1, 1, 1, headerWidth).setValues([machineHeaders]);
      sheet.getRange(2, 1, 1, headerWidth).setValues([display]);
      Log.warn(`Restored missing machine/display headers on ${name}`);
    });
  }

  function resetSheetToSchema(sheet: GoogleAppsScript.Spreadsheet.Sheet, schema: Types.TabSchema) {
    const { machineHeaders, displayHeaders } = schema;
    if (!machineHeaders || machineHeaders.length === 0) {
      Log.warn(`Cannot reset sheet ${sheet.getName()} to schema: machine headers missing.`);
      return;
    }
    const headerWidth = machineHeaders.length;

    // Ensure column count matches schema width.
    const maxCols = sheet.getMaxColumns();
    if (maxCols < headerWidth) {
      sheet.insertColumnsAfter(maxCols, headerWidth - maxCols);
    } else if (maxCols > headerWidth) {
      sheet.deleteColumns(headerWidth + 1, maxCols - headerWidth);
    }

    // Clear all content and reapply headers.
    sheet.clear();
    sheet.getRange(1, 1, 1, headerWidth).setValues([machineHeaders]);
    const display = displayHeaders && displayHeaders.length === headerWidth ? displayHeaders : machineHeaders;
    sheet.getRange(2, 1, 1, headerWidth).setValues([display]);
  }

  function apiColorStyle(hex: string) {
    const clean = hex.replace('#', '');
    const n = parseInt(clean, 16);
    return {
      rgbColor: {
        red: ((n >> 16) & 255) / 255,
        green: ((n >> 8) & 255) / 255,
        blue: (n & 255) / 255,
      },
    };
  }

  function tableVisualStyleRequests(
    sheetId: number,
    startColumnIndex: number,
    endColumnIndex: number,
    headerRowIndex: number,
    endRowIndex: number,
  ): Record<string, any>[] {
    const headerGreen = '#356854';
    const bodyText = '#434343';
    const bodyWhite = '#FFFFFF';
    const bodyBand = '#F6F8F9';
    const requests: Record<string, any>[] = [
      {
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: headerRowIndex,
            endRowIndex: headerRowIndex + 1,
            startColumnIndex,
            endColumnIndex,
          },
          cell: {
            userEnteredFormat: {
              backgroundColorStyle: apiColorStyle(headerGreen),
              horizontalAlignment: 'LEFT',
              verticalAlignment: 'MIDDLE',
              wrapStrategy: 'CLIP',
              textFormat: {
                foregroundColorStyle: apiColorStyle('#FFFFFF'),
                bold: true,
              },
            },
          },
          fields: 'userEnteredFormat.backgroundColorStyle,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy,userEnteredFormat.textFormat.foregroundColorStyle,userEnteredFormat.textFormat.bold',
        },
      },
    ];

    const dataStartRowIndex = headerRowIndex + 1;
    if (endRowIndex > dataStartRowIndex) {
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: dataStartRowIndex,
            endRowIndex,
            startColumnIndex,
            endColumnIndex,
          },
          cell: {
            userEnteredFormat: {
              backgroundColorStyle: apiColorStyle(bodyWhite),
              verticalAlignment: 'MIDDLE',
              wrapStrategy: 'CLIP',
              textFormat: {
                foregroundColorStyle: apiColorStyle(bodyText),
                bold: false,
              },
            },
          },
          fields: 'userEnteredFormat.backgroundColorStyle,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy,userEnteredFormat.textFormat.foregroundColorStyle,userEnteredFormat.textFormat.bold',
        },
      });

      for (let rowIndex = dataStartRowIndex + 1; rowIndex < endRowIndex; rowIndex += 2) {
        requests.push({
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: rowIndex,
              endRowIndex: rowIndex + 1,
              startColumnIndex,
              endColumnIndex,
            },
            cell: {
              userEnteredFormat: {
                backgroundColorStyle: apiColorStyle(bodyBand),
              },
            },
            fields: 'userEnteredFormat.backgroundColorStyle',
          },
        });
      }
    }

    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: headerRowIndex,
          endRowIndex,
          startColumnIndex,
          endColumnIndex,
        },
        cell: { userEnteredFormat: { borders: {} } },
        fields: 'userEnteredFormat.borders',
      },
    });

    return requests;
  }

  function sheetsBatchUpdateWithRetry(svc: any, spreadsheetId: string, requests: Record<string, any>[], label: string): boolean {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        svc.batchUpdate({ requests: requests as any[] }, spreadsheetId);
        return true;
      } catch (err) {
        const message = String(err || '');
        const transient = message.includes('Internal error') || message.includes('Service unavailable') || message.includes('Rate Limit') || message.includes('Quota');
        if (!transient || attempt === maxAttempts) {
          Log.warn(`${label} failed after ${attempt} attempt(s): ${err}`);
          return false;
        }
        Log.warn(`${label} transient failure on attempt ${attempt}; retrying: ${err}`);
        Utilities.sleep(500 * attempt);
      }
    }
    return false;
  }

  const FRONTEND_TABLE_SHEETS = ['Directory', 'Leadership', 'Attendance', 'Data Legend'];

  function tableIdForName(tableName: string): string {
    return String(tableName || 'table')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'table';
  }

  function ensureTableForSheet(spreadsheetId: string, sheetName: string, tableName = sheetName) {
    const tableId = tableIdForName(tableName);
    const displayTableName = String(tableName || sheetName).trim() || sheetName;
    // Sheets advanced service may be disabled in some environments; skip gracefully if absent.
    if (typeof (globalThis as any).Sheets === 'undefined') {
      Log.warn(`Sheets advanced service unavailable; cannot create tables for ${sheetName}`);
      return;
    }

    try {
      const ss = SpreadsheetApp.openById(spreadsheetId);
      const sheet = Config.getBackendId() === spreadsheetId
        ? Config.getBackendSheet(sheetName)
        : Config.getFrontendId() === spreadsheetId
          ? Config.getFrontendSheet(sheetName)
          : (() => {
              const found = ss.getSheetByName(sheetName);
              if (!found) {
                const msg = `Sheet ${sheetName} missing; cannot ensure table ${tableId}.`;
                Log.error(msg);
                throw new Error(msg);
              }
              return found;
            })();
      const sheetId = sheet.getSheetId();

      const svc = (Sheets as any)?.Spreadsheets;
      if (!svc || !svc.batchUpdate) {
        Log.warn('Sheets advanced service unavailable; cannot create tables');
        return;
      }

      const headerRow = 2; // display headers live on row 2
      const headerValues = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getValues()[0];
      const colCount = headerValues.length;
      if (colCount === 0) return;
      const endColIndex = colCount; // zero-based exclusive
      const endRowIndex = Math.max(headerRow + 1, sheet.getLastRow());

      const tableRange = {
        sheetId,
        startColumnIndex: 0,
        endColumnIndex: endColIndex,
        startRowIndex: headerRow - 1, // zero-based (row 2)
        endRowIndex,
      };

      const baseTable = {
        name: displayTableName,
        tableId,
        range: tableRange,
        rowsProperties: {
          headerColorStyle: apiColorStyle('#356854'),
          firstBandColorStyle: apiColorStyle('#FFFFFF'),
          secondBandColorStyle: apiColorStyle('#F6F8F9'),
        },
      };

      const existingTable = findExistingTable(svc, spreadsheetId, sheetId, tableId, displayTableName);
      const baseRequest = existingTable
        ? {
            updateTable: {
              table: { ...baseTable, tableId: existingTable.tableId },
              fields: 'name,range,rowsProperties',
            },
          }
        : {
            addTable: {
              table: baseTable,
            },
          };

      const baseOk = sheetsBatchUpdateWithRetry(svc, spreadsheetId, [baseRequest as any], `Ensure table ${tableId} on ${sheetName}`);
      if (!baseOk) {
        Log.warn(`Unable to ensure table ${displayTableName} on sheet ${sheetName}; applying visual formatting fallback only.`);
      }

      sheetsBatchUpdateWithRetry(
        svc,
        spreadsheetId,
        tableVisualStyleRequests(sheetId, 0, endColIndex, headerRow - 1, endRowIndex),
        `Apply table visual style ${tableId} on ${sheetName}`,
      );
      Log.info(`Ensured table styling path completed for ${tableId} on sheet ${sheetName}`);
    } catch (err) {
      Log.warn(`Unable to ensure table ${displayTableName} on sheet ${sheetName}: ${err}`);
    }
  }

  function findExistingTable(svc: any, spreadsheetId: string, sheetId: number, tableId: string, tableName: string): any | null {
    try {
      if (!svc.get) return null;
      const spreadsheet = svc.get(spreadsheetId, {
        fields: 'sheets(properties(sheetId),tables(tableId,name,range))',
      });
      const targetSheet = (spreadsheet.sheets || []).find((sh: any) => sh?.properties?.sheetId === sheetId);
      const tables = targetSheet?.tables || [];
      return tables.find((table: any) => table?.tableId === tableId || table?.name === tableId || table?.name === tableName) || null;
    } catch (err) {
      Log.warn(`Unable to inspect existing table ${tableId}: ${err}`);
      return null;
    }
  }

  function isFrontendFormattingDisabled(): boolean {
    try {
      return Config.getBooleanScriptProperty(Config.PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_FORMATTING);
    } catch (err) {
      Log.warn(`Unable to read ${Config.PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_FORMATTING} property: ${err}`);
      return false;
    }
  }

  const RESPONSE_SHEET_REGEX = /^form responses?/i;

  function ensureResponseSheetName(spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet, desiredName: string): boolean {
    const current = spreadsheet.getSheetByName(desiredName);
    const candidates = spreadsheet.getSheets().filter((s) => RESPONSE_SHEET_REGEX.test(s.getName()));

    if (current) {
      // Desired sheet already present; do not delete other response sheets to avoid breaking links.
      return true;
    }

    if (candidates.length === 0) {
      const names = spreadsheet
        .getSheets()
        .map((s) => s.getName())
        .join(', ');
      Log.info(`No response sheet found to rename to ${desiredName} in spreadsheet=${spreadsheet.getId()} (sheet names: ${names})`);
      return false;
    }

    const primary = candidates[0];
    if (primary.getName() !== desiredName) {
      Log.info(`Renaming response sheet ${primary.getName()} -> ${desiredName}`);
      primary.setName(desiredName);
    }

    // Leave any additional Form Responses sheets untouched to avoid deleting linked sheets; log for awareness.
    candidates.slice(1).forEach((s) => {
      if (s.getName() !== desiredName) {
        Log.warn(`Additional response sheet present (${s.getName()}); leaving as-is to avoid unlinking forms.`);
      }
    });
    return true;
  }

  function copySheetToArchive(
    ss: GoogleAppsScript.Spreadsheet.Spreadsheet,
    source: GoogleAppsScript.Spreadsheet.Sheet,
    archivePrefix: string,
  ): GoogleAppsScript.Spreadsheet.Sheet | null {
    const archiveName = `${archivePrefix}${source.getName()}`.trim();

    // Replace only the canonical archive sheet for this source; leave any user-renamed archives intact.
    const existingArchive = ss.getSheetByName(archiveName);
    if (existingArchive) {
      try {
        ss.deleteSheet(existingArchive);
      } catch (err) {
        Log.warn(`Unable to delete existing archive sheet ${archiveName}: ${err}`);
        return null;
      }
    }

    let archived: GoogleAppsScript.Spreadsheet.Sheet;
    try {
      archived = source.copyTo(ss);
    } catch (err) {
      Log.warn(`Unable to copy sheet ${source.getName()} to archive ${archiveName}: ${err}`);
      return null;
    }

    try {
      archived.setName(archiveName);
      SheetUtils.renameTablesOnSheet(ss.getId(), archived, archiveName);
    } catch (err) {
      Log.warn(`Unable to rename archive copy to ${archiveName}: ${err}`);
    }

    // Sever links: strip formulas, named ranges, and protections.
    const range = archived.getDataRange();
    range.copyTo(range, { contentsOnly: true });
    archived.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach((p) => p.remove());
    archived.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach((p) => p.remove());
    try {
      const protection = archived.protect().setDescription(`${archiveName} (locked)`);
      protection.setWarningOnly(false);
      try {
        protection.removeEditors(protection.getEditors());
      } catch (err) {
        Log.warn(`Unable to remove editors from ${archiveName}: ${err}`);
      }
      if (protection.canDomainEdit && protection.canDomainEdit()) {
        try {
          protection.setDomainEdit(false);
        } catch (err) {
          Log.warn(`Unable to disable domain edit on ${archiveName}: ${err}`);
        }
      }
    } catch (err) {
      Log.warn(`Unable to protect archive sheet ${archiveName}: ${err}`);
    }

    ss.setActiveSheet(archived);
    ss.moveActiveSheet(ss.getSheets().length);

    return archived;
  }

  function archiveAndResetSheets(
    spreadsheetId: string,
    schemas: Types.TabSchema[],
    names: string[],
    archivePrefix = 'Archive ',
  ) {
    if (!spreadsheetId) {
      Log.warn('No spreadsheetId provided to archiveAndResetSheets; skipping.');
      return;
    }
    const ss = SpreadsheetApp.openById(spreadsheetId);

    names.forEach((name) => {
      const schema = schemas.find((s) => s.name === name);
      if (!schema || !schema.machineHeaders) {
        Log.warn(`Schema missing for ${name}; skipping archive/reset.`);
        return;
      }
      const sheet = ss.getSheetByName(name);
      if (!sheet) {
        Log.warn(`Sheet ${name} not found in spreadsheet=${spreadsheetId}; skipping archive/reset.`);
        return;
      }

      copySheetToArchive(ss, sheet, archivePrefix);

      resetSheetToSchema(sheet, schema);
    });
  }

  function restoreFromArchiveSheets(
    spreadsheetId: string,
    schemas: Types.TabSchema[],
    names: string[],
    archivePrefix = 'Archive ',
  ) {
    if (!spreadsheetId) {
      Log.warn('No spreadsheetId provided to restoreFromArchiveSheets; skipping.');
      return;
    }
    const ss = SpreadsheetApp.openById(spreadsheetId);

    names.forEach((name) => {
      const schema = schemas.find((s) => s.name === name);
      if (!schema || !schema.machineHeaders) {
        Log.warn(`Schema missing for ${name}; skipping restore from archive.`);
        return;
      }
      let target = ss.getSheetByName(name);
        const archive = ss.getSheetByName(`${archivePrefix}${name}`);
        if (!archive) {
          Log.warn(`No archive sheet found for ${name}; skipping restore.`);
          return;
        }
      if (!target) {
        target = ss.insertSheet(name);
      }

      const values = archive.getDataRange().getValues();
      const width = Math.max(schema.machineHeaders.length, values[0]?.length || 0);

      const maxCols = target.getMaxColumns();
      if (maxCols < width) target.insertColumnsAfter(maxCols, width - maxCols);
      if (maxCols > width) target.deleteColumns(width + 1, maxCols - width);

      target.clear();
      if (values.length && values[0].length) {
        target.getRange(1, 1, values.length, values[0].length).setValues(values);
      }
    });
  }

  function ensureResponseSheetNameWithRetry(spreadsheetId: string, desiredName: string, retries = 3, delayMs = 500) {
    for (let attempt = 0; attempt < retries; attempt++) {
      const ss = SpreadsheetApp.openById(spreadsheetId);
      const ok = ensureResponseSheetName(ss, desiredName);
      if (ok) return;
      Utilities.sleep(delayMs);
    }
    Log.warn(`Unable to find response sheet for ${desiredName} after ${retries} attempts in spreadsheet=${spreadsheetId}; skipping placeholder.`);
  }

  // Minimal response sheet handling: set destination once, wait, rename the linked sheet (or first response-ish) to desiredName.
  function ensureResponseSheetForForm(form: GoogleAppsScript.Forms.Form, desiredName: string, spreadsheetId: string) {
    const currentDest = getFormDestinationSpreadsheetId(form);
    if (!currentDest || currentDest !== spreadsheetId) {
      try {
        form.setDestination(FormApp.DestinationType.SPREADSHEET, spreadsheetId);
      } catch (err) {
        Log.warn(`Unable to set destination for formId=${form.getId()} to spreadsheet=${spreadsheetId}: ${err}`);
        return;
      }
    }

    // Poll for the linked response sheet to appear; Forms can lag before creating it.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) Utilities.sleep(500);
      const ss = SpreadsheetApp.openById(spreadsheetId);
      const sheets = ss.getSheets();

      // Prefer the sheet actually linked to this form.
      const linked = sheets.filter((s) => {
        try {
          const url = s.getFormUrl?.();
          return url && url.includes(form.getId());
        } catch {
          return false;
        }
      });

      const candidates = linked.length
        ? linked
        : sheets.filter((s) => RESPONSE_SHEET_REGEX.test(s.getName()) || s.getName() === desiredName);

      const target = ss.getSheetByName(desiredName) || candidates[0];
      if (!target) continue;

      if (target.getName() !== desiredName) {
        try {
          target.setName(desiredName);
        } catch (err) {
          Log.warn(`Unable to rename response sheet ${target.getName()} -> ${desiredName}: ${err}`);
        }
      }
      return;
    }

    // Never create a same-named placeholder. Forms can take tens of seconds to
    // create and backfill a real linked response tab, and a blank placeholder
    // can then mask that destination and break downstream lookups.
    Log.warn(
      `Linked response sheet '${desiredName}' was not visible yet for formId=${form.getId()}; leaving the workbook unchanged for a later retry.`,
    );
  }

  /**
   * Safely remove duplicate columns from the Excusals Form Responses sheet.
   * Processes ONE duplicate at a time, re-reading headers after each deletion
   * to avoid index shifting corruption.
   */
  function safeDeduplicateExcusalsResponseColumns() {
    let sheet: GoogleAppsScript.Spreadsheet.Sheet;
    try {
      sheet = Config.getBackendSheet(Config.RESOURCE_NAMES.EXCUSALS_FORM_SHEET);
    } catch (err) {
      Log.warn(`Excusals response sheet missing; skipping dedup. Error: ${err}`);
      return;
    }

    let totalDeleted = 0;

    // Outer loop: keep going until no more duplicates can be removed
    for (let round = 0; round < 50; round++) {
      const lastCol = sheet.getLastColumn();
      const lastRow = sheet.getLastRow();
      if (lastCol === 0) break;

      const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h || '').trim());

      // Find the FIRST duplicate header pair
      let dupHeader = '';
      let cols: number[] = [];
      const seen = new Map<string, number>();
      for (let i = 0; i < headers.length; i++) {
        const h = headers[i];
        if (!h || /^Column \d+$/i.test(h)) continue;
        if (seen.has(h)) {
          dupHeader = h;
          cols = [seen.get(h)! + 1, i + 1]; // 1-based
          break;
        }
        seen.set(h, i);
      }

      if (!dupHeader) {
        // No more duplicates — now delete empty "Column N" columns
        for (let i = headers.length - 1; i >= 0; i--) {
          if (/^Column \d+$/i.test(headers[i])) {
            // Check if empty
            let empty = true;
            if (lastRow > 1) {
              const colData = sheet.getRange(2, i + 1, lastRow - 1, 1).getValues();
              empty = colData.every((r) => !String(r[0] || '').trim());
            }
            if (empty) {
              try {
                sheet.deleteColumn(i + 1);
                totalDeleted++;
                Log.info(`[excusal-dedup] Deleted empty Column N at position ${i + 1}`);
              } catch {}
            }
          }
        }
        break;
      }

      Log.info(`[excusal-dedup] Round ${round + 1}: deduping "${dupHeader}" at cols ${cols.join(', ')}`);

      // Merge data: fill empty cells in each column from the other
      if (lastRow > 1) {
        const dataA = sheet.getRange(2, cols[0], lastRow - 1, 1).getValues();
        const dataB = sheet.getRange(2, cols[1], lastRow - 1, 1).getValues();
        for (let r = 0; r < lastRow - 1; r++) {
          const a = String(dataA[r][0] || '').trim();
          const b = String(dataB[r][0] || '').trim();
          if (!a && b) dataA[r][0] = b;
          if (!b && a) dataB[r][0] = a;
        }
        sheet.getRange(2, cols[0], lastRow - 1, 1).setValues(dataA);
        sheet.getRange(2, cols[1], lastRow - 1, 1).setValues(dataB);
      }

      // Try to delete one of them (right one first, then left)
      let deleted = false;
      for (const col of [cols[1], cols[0]]) {
        try {
          sheet.deleteColumn(col);
          totalDeleted++;
          deleted = true;
          Log.info(`[excusal-dedup] Deleted col ${col} for "${dupHeader}"`);
          break;
        } catch {
          Log.info(`[excusal-dedup] Col ${col} is form-linked for "${dupHeader}", trying other`);
        }
      }

      if (!deleted) {
        Log.info(`[excusal-dedup] Both columns for "${dupHeader}" are form-linked; hiding col ${cols[1]}`);
        try { sheet.hideColumns(cols[1]); } catch {}
        break; // Can't make progress, stop
      }
    }

    Log.info(`[excusal-dedup] Done: ${totalDeleted} columns removed`);
  }

  /**
   * @deprecated Use safeDeduplicateExcusalsResponseColumns instead.
   */
  function pruneExcusalsResponseColumnsExplicit(_verbose = true) {
    safeDeduplicateExcusalsResponseColumns();
  }

  // Verbose debug entrypoint to inspect and prune excusals Event columns; callable from Apps Script.
  export function debugExcusalsResponseColumnsVerbose() {
    pruneExcusalsResponseColumnsExplicit(true);
    try {
      const sheet = Config.getBackendSheet(Config.RESOURCE_NAMES.EXCUSALS_FORM_SHEET);
      const lastCol = sheet.getLastColumn();
      const headers = lastCol
        ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h || ''))
        : [];
      Log.info(`[excusal-prune] Final headers (${headers.length} cols): ${headers.map((h, i) => `${i + 1}:'${h}'`).join(', ')}`);
      return headers;
    } catch (err) {
      Log.warn(`[excusal-prune] Unable to log final headers: ${err}`);
      return [];
    }
  }

  /**
   * Deep-clean the Excusals Form Responses sheet:
   * 1. Merge same-name duplicate columns into their active counterpart
   * 2. Distribute legacy "Column 23" event data into category-specific event columns
   * 3. Merge "Column 27" requested outcome data into Requested Outcome
   * 4. Merge "Column 24" last names into Last Name (if active is empty)
   * 5. Delete empty/redundant orphan columns
   */
  export function deepCleanExcusalsFormResponses(): { merged: number; deleted: number } {
    let sheet: GoogleAppsScript.Spreadsheet.Sheet;
    try {
      sheet = Config.getBackendSheet(Config.RESOURCE_NAMES.EXCUSALS_FORM_SHEET);
    } catch (err) {
      Log.warn(`Excusals response sheet missing; skipping deep clean. Error: ${err}`);
      return { merged: 0, deleted: 0 };
    }

    const lastCol = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();
    if (lastCol === 0 || lastRow < 2) return { merged: 0, deleted: 0 };

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h || '').trim());
    const dataRows = lastRow - 1;
    const data = sheet.getRange(2, 1, dataRows, lastCol).getValues();

    Log.info(`[deep-clean-excusals] Starting: ${lastCol} cols, ${dataRows} data rows`);
    headers.forEach((h, i) => Log.info(`  Col ${i + 1}: "${h}"`));

    // Map of canonical header → active column index (0-based)
    const ACTIVE_COLS: Record<string, number> = {};
    const CANONICAL = [
      'Timestamp', 'Email Address', 'Name', 'Last Name', 'First Name',
      'Select Event Type (or Done to continue)',
      'Select Event(s) (Mando)', 'Select Event(s) (LLAB)', 'Select Event(s) (POC Third Hour)',
      'Select Event(s) (Secondary)', 'Select Event(s) (Other)',
      'Requested Outcome', 'Reason',
    ];
    CANONICAL.forEach((name) => {
      const idx = headers.indexOf(name);
      if (idx >= 0) ACTIVE_COLS[name] = idx;
    });

    let mergedCells = 0;

    // Helper: merge source col data into target col (only fill empty target cells)
    const mergeCol = (srcIdx: number, tgtIdx: number) => {
      for (let r = 0; r < dataRows; r++) {
        const tgtVal = String(data[r][tgtIdx] || '').trim();
        const srcVal = String(data[r][srcIdx] || '').trim();
        if (!tgtVal && srcVal) {
          data[r][tgtIdx] = srcVal;
          mergedCells++;
        }
      }
    };

    // Helper: append value to target col (comma-separated, avoiding duplicates)
    const appendToCol = (row: number, tgtIdx: number, value: string) => {
      const existing = String(data[row][tgtIdx] || '').trim();
      const existingParts = existing ? existing.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (!existingParts.includes(value)) {
        existingParts.push(value);
        data[row][tgtIdx] = existingParts.join(', ');
        mergedCells++;
      }
    };

    // 1. Merge same-name duplicate columns (cols beyond the first 13 active ones)
    for (let ci = CANONICAL.length; ci < headers.length; ci++) {
      const header = headers[ci];
      if (!header || header.startsWith('Column ')) continue;
      const activeIdx = ACTIVE_COLS[header];
      if (activeIdx !== undefined && activeIdx !== ci) {
        Log.info(`[deep-clean-excusals] Merging duplicate col ${ci + 1} "${header}" → active col ${activeIdx + 1}`);
        mergeCol(ci, activeIdx);
      }
    }

    // 2. Distribute "Column 23" legacy event data into category-specific columns
    const col23Idx = headers.findIndex((h) => h === 'Column 23');
    if (col23Idx >= 0) {
      const mandoIdx = ACTIVE_COLS['Select Event(s) (Mando)'];
      const llabIdx = ACTIVE_COLS['Select Event(s) (LLAB)'];
      const pocIdx = ACTIVE_COLS['Select Event(s) (POC Third Hour)'];
      const secIdx = ACTIVE_COLS['Select Event(s) (Secondary)'];
      const otherIdx = ACTIVE_COLS['Select Event(s) (Other)'];

      for (let r = 0; r < dataRows; r++) {
        const raw = String(data[r][col23Idx] || '').trim();
        if (!raw) continue;
        const events = raw.split(',').map((e) => e.trim()).filter(Boolean);
        for (const ev of events) {
          const evLower = ev.toLowerCase();
          if (evLower.includes('mando') && mandoIdx !== undefined) {
            appendToCol(r, mandoIdx, ev);
          } else if (evLower.includes('llab') && llabIdx !== undefined) {
            appendToCol(r, llabIdx, ev);
          } else if (evLower.includes('poc') && pocIdx !== undefined) {
            appendToCol(r, pocIdx, ev);
          } else if (evLower.includes('secondary') && secIdx !== undefined) {
            appendToCol(r, secIdx, ev);
          } else if (otherIdx !== undefined) {
            appendToCol(r, otherIdx, ev);
          }
        }
      }
      Log.info(`[deep-clean-excusals] Distributed Column 23 legacy events to active category columns`);
    }

    // 3. Merge "Column 27" — mostly requested outcomes, some POC events
    const col27Idx = headers.findIndex((h) => h === 'Column 27');
    if (col27Idx >= 0) {
      const reqTypeIdx = ACTIVE_COLS['Requested Outcome'];
      const pocIdx = ACTIVE_COLS['Select Event(s) (POC Third Hour)'];
      const REQUESTED_OUTCOMES = new Set(Arrays.EXCUSAL_REQUESTED_OUTCOMES);

      for (let r = 0; r < dataRows; r++) {
        const raw = String(data[r][col27Idx] || '').trim();
        if (!raw) continue;
        if (REQUESTED_OUTCOMES.has(raw) && reqTypeIdx !== undefined) {
          const existing = String(data[r][reqTypeIdx] || '').trim();
          if (!existing) {
            data[r][reqTypeIdx] = raw;
            mergedCells++;
          }
        } else if (raw.toLowerCase().includes('poc') && pocIdx !== undefined) {
          const events = raw.split(',').map((e) => e.trim()).filter(Boolean);
          for (const ev of events) {
            appendToCol(r, pocIdx, ev);
          }
        }
      }
      Log.info(`[deep-clean-excusals] Merged Column 27 data`);
    }

    // 4. Merge "Column 24" last names into active Last Name (if empty)
    const col24Idx = headers.findIndex((h) => h === 'Column 24');
    const lastNameIdx = ACTIVE_COLS['Last Name'];
    if (col24Idx >= 0 && lastNameIdx !== undefined) {
      mergeCol(col24Idx, lastNameIdx);
      Log.info(`[deep-clean-excusals] Merged Column 24 into Last Name`);
    }

    // Write merged data back
    sheet.getRange(2, 1, dataRows, lastCol).setValues(data);
    Log.info(`[deep-clean-excusals] Wrote back data; ${mergedCells} cells merged`);

    // 5. Delete orphan columns (right-to-left to keep indices stable)
    // Orphans are anything beyond the first 13 canonical columns
    let deletedCols = 0;
    for (let ci = headers.length - 1; ci >= CANONICAL.length; ci--) {
      try {
        sheet.deleteColumn(ci + 1);
        deletedCols++;
        Log.info(`[deep-clean-excusals] Deleted col ${ci + 1} "${headers[ci]}"`);
      } catch (err) {
        // Form-linked column — can't delete, skip
        Log.info(`[deep-clean-excusals] Cannot delete col ${ci + 1} "${headers[ci]}" (likely form-linked)`);
      }
    }

    Log.info(`[deep-clean-excusals] Done: ${mergedCells} cells merged, ${deletedCols} columns deleted`);
    return { merged: mergedCells, deleted: deletedCols };
  }

  /**
   * Process any existing rows in the Excusals Form Responses sheet that haven't been
   * inserted into Excusals Backend yet (pre-online submissions/backfill).
   */
  export function processExcusalsFormBacklog() {
    try {
      const respSheet = Config.getBackendSheet(Config.RESOURCE_NAMES.EXCUSALS_FORM_SHEET);
      const lastCol = respSheet.getLastColumn();
      const lastRow = respSheet.getLastRow();
      if (lastCol === 0 || lastRow < 2) {
        Log.info('No excusals form responses found; nothing to backfill.');
        return;
      }

      const headers = respSheet.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h || '').trim());
      const headerIndex = (name: string, normalize?: (s: string) => string) => {
        const n = normalize ? headers.map((h) => normalize(h)) : headers;
        return n.indexOf(name);
      };

      // Normalize 'Event' header variants like 'Event (Other)', 'Event 2', etc.
      const normalizeEventHeader = (raw: string) => {
        const h = (raw || '').trim().toLowerCase();
        if (h === 'event' || /^event\s*\d+$/i.test(raw) || /^event\s*\(\d+\)$/i.test(raw) || /^event\b.*other/i.test(raw)) {
          return 'event';
        }
        return (raw || '').trim();
      };

      // Normalize 'Email' header variants like 'Email Address', 'Email', etc.
      const normalizeEmailHeader = (raw: string) => {
        const h = (raw || '').trim().toLowerCase();
        if (h === 'email' || h.startsWith('email')) {
          return 'email';
        }
        return (raw || '').trim();
      };

      const tsIdx = headerIndex('Timestamp');
      const emailIdx = headers.map((h) => normalizeEmailHeader(h)).indexOf('email');
      const lastIdx = headerIndex('Last Name');
      const firstIdx = headerIndex('First Name');
      const reasonIdx = headerIndex('Reason');
      const eventIdx = headers.map((h) => normalizeEventHeader(h)).indexOf('event');
      const reqTypeIdx = headerIndex('Requested Outcome');

      if (eventIdx < 0 || emailIdx < 0) {
        throw new Error('Excusals responses missing required headers (Event/Email); cannot backfill.');
      }

      // Build existing key set from Excusals Backend to avoid duplicates.
      const backendSheet = Config.getBackendSheet('Excusals Backend');
      const backendLastCol = backendSheet.getLastColumn();
      const backendHeaders = backendLastCol
        ? backendSheet.getRange(1, 1, 1, backendLastCol).getValues()[0].map((h) => String(h || '').trim().toLowerCase())
        : [];
      const backend = SheetUtils.readTable(backendSheet);
      const emailColB = backendHeaders.indexOf('email');
      const eventColB = backendHeaders.indexOf('event');
      const submittedColB = backendHeaders.indexOf('submitted_at');
      const existingKeys = new Set<string>();
      backend.rows.forEach((row) => {
        const e = String(row['email'] || '').toLowerCase().trim();
        const ev = String(row['event'] || '').trim();
        const ts = String(row['submitted_at'] || '').trim();
        if (e && ev && ts) existingKeys.add(`${e}|${ev}|${ts}`);
      });

      const toAppend: Record<string, any>[] = [];
      const toSync: Record<string, any>[] = [];

      // Helper: lookup cadet by email from Directory Backend
      const lookupCadetByEmail = (addr: string) => {
        const backendId = Config.getBackendId();
        if (!backendId || !addr) return null;
        const directorySheet = SheetUtils.getSheet(backendId, 'Directory Backend');
        if (!directorySheet) return null;
        const data = SheetUtils.readTable(directorySheet);
        const lower = addr.toLowerCase();
        return data.rows.find((r) => String(r['email'] || '').toLowerCase() === lower) || null;
      };

      const values = respSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      values.forEach((row) => {
        const email = emailIdx >= 0 ? String(row[emailIdx] || '').trim() : '';
        const lastName = lastIdx >= 0 ? String(row[lastIdx] || '').trim() : '';
        const firstName = firstIdx >= 0 ? String(row[firstIdx] || '').trim() : '';
        const reason = reasonIdx >= 0 ? String(row[reasonIdx] || '').trim() : '';
        const requestedOutcomeRaw = reqTypeIdx >= 0 ? String(row[reqTypeIdx] || '').trim().toUpperCase() : '';
        const requestedOutcome = Arrays.EXCUSAL_REQUESTED_OUTCOMES.includes(requestedOutcomeRaw) ? requestedOutcomeRaw : 'E';
        const tsVal = tsIdx >= 0 ? row[tsIdx] : '';
        const submittedAt = (() => {
          try { return new Date(tsVal).toISOString(); } catch { return new Date().toISOString(); }
        })();

        const eventsRaw = String(row[eventIdx] || '').trim();
        const events = eventsRaw
          .split(',')
          .map((ev) => ev.trim())
          .filter(Boolean);

        if (!email || !events.length) return;

        const cadet = lookupCadetByEmail(email);

        events.forEach((eventName) => {
          const key = `${email.toLowerCase()}|${eventName}|${submittedAt}`;
          if (existingKeys.has(key)) return;

          const requestId = `exc-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
          const backendRow = {
            request_id: requestId,
            event: eventName,
            email,
            last_name: cadet?.last_name || lastName,
            first_name: cadet?.first_name || firstName,
            flight: cadet?.flight || '',
            squadron: cadet?.squadron || '',
            status: 'Submitted',
            decision: '',
            decided_by: '',
            decided_at: '',
            requested_outcome: requestedOutcome,
            attendance_effect: 'R',
            prior_attendance_code: ExcusalsService.getCurrentAttendanceCode(
              eventName,
              String(cadet?.last_name || lastName),
              String(cadet?.first_name || firstName),
            ),
            submitted_at: submittedAt,
            last_updated_at: submittedAt,
            reason,
          };

          toAppend.push(backendRow);
          toSync.push(backendRow);
        });
      });

      if (!toAppend.length) {
        Log.info('No unprocessed excusals responses found.');
        return;
      }

      SheetUtils.appendRows(backendSheet, toAppend);
      toSync.forEach((row) => {
        ExcusalsService.notifySquadronCommanderOfNewExcusal(row);
        ExcusalsService.syncExcusalToManagementPanel(row);
        ExcusalsService.updateAttendanceOnExcusalSubmission(row);
      });

      Log.info(`Processed excusals form backlog: appended ${toAppend.length} event rows.`);
    } catch (err) {
      Log.warn(`Failed to process excusals form backlog: ${err}`);
      throw err;
    }
  }

  /**
   * Privacy-safe diagnostic for Attendance Form response-sheet column growth.
   * It intentionally does not log response values or cadet data.
   */
  export function debugAttendanceResponseSheet() {
    try {
      const respSheet = Config.getBackendSheet(Config.RESOURCE_NAMES.ATTENDANCE_FORM_SHEET);
      const diagnostics = logAttendanceResponseSheetHealth(respSheet);
      diagnostics.duplicateHeaders.slice(0, 25).forEach(([header, count]) => {
        Log.warn(`Attendance response duplicate header occurrences=${count} header='${header}'`);
      });
      return diagnostics;
    } catch (err) {
      Log.warn(`debugAttendanceResponseSheet failed: ${err}`);
      throw err;
    }
  }

  /**
   * Process any existing rows in the Attendance Form Responses sheet that haven't been
   * inserted into Attendance Backend yet (backfill for new multi-category form structure).
   */
  export function processAttendanceFormBacklog() {
    try {
      const respSheet = Config.getBackendSheet(Config.RESOURCE_NAMES.ATTENDANCE_FORM_SHEET);
      const lastCol = respSheet.getLastColumn();
      const lastRow = respSheet.getLastRow();
      if (lastCol === 0 || lastRow < 2) {
        Log.info('No attendance form responses found; nothing to backfill.');
        return;
      }

      const headers = respSheet.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h || '').trim());

      // Find column indices
      const tsIdx = headers.indexOf('Timestamp');
      const emailIdx = headers.findIndex((h) => h.toLowerCase().includes('email'));
      const nameIdx = headers.findIndex((h) => h.toLowerCase() === 'name');
      const eventTypeIdx = headers.findIndex((h) => h.toLowerCase() === 'event type');
      const flightCrosstownIdx = headers.findIndex((h) => h.toLowerCase().includes('flight') && h.toLowerCase().includes('crosstown'));

      // Find all "Select Event" columns (but exclude any that contain "Cadets" to avoid confusion)
      const selectEventIndices: number[] = [];
      headers.forEach((h, idx) => {
        const lower = h.toLowerCase();
        if (lower.includes('select event') && !lower.includes('cadet')) {
          selectEventIndices.push(idx);
        }
      });

      // Find all cadet checkbox columns (pattern: "Cadets (...) AS AS... (...)")
      const cadetColumnIndices: Array<{ idx: number; title: string }> = [];
      headers.forEach((h, idx) => {
        if (h.toLowerCase().includes('cadets') && h.toLowerCase().includes('as ')) {
          cadetColumnIndices.push({ idx, title: h });
        }
      });

      if (selectEventIndices.length === 0) {
        throw new Error('Attendance responses missing "Select Event" columns; cannot backfill.');
      }

      Log.info(`Found ${selectEventIndices.length} "Select Event" columns and ${cadetColumnIndices.length} cadet columns`);
      Log.info(`Email col: ${emailIdx}, Name col: ${nameIdx}, Flight col: ${flightCrosstownIdx}`);

      // Build existing key set from Attendance Backend to avoid duplicates
      const backendSheet = Config.getBackendSheet('Attendance Backend');
      const backend = SheetUtils.readTable(backendSheet);
      const existingKeys = new Set<string>();
      backend.rows.forEach((row) => {
        const e = String(row['email'] || '').toLowerCase().trim();
        const ev = String(row['event'] || '').trim();
        const ts = String(row['submitted_at'] || '').trim();
        if (e && ev && ts) existingKeys.add(`${e}|${ev}|${ts}`);
      });

      // Helper: normalize cadet list from response value
      const normalizeCadetList = (val: any): string[] => {
        if (!val) return [];
        const s = String(val).trim();
        if (!s) return [];
        // Google Forms checkbox responses are semicolon-separated: "Last, First; Last, First; ..."
        return s.split(';').map((n) => n.trim()).filter(Boolean);
      };

      // Helper: lookup cadet by email for flight/squadron info
      const lookupCadetByEmail = (addr: string) => {
        const backendId = Config.getBackendId();
        if (!backendId || !addr) return null;
        const directorySheet = SheetUtils.getSheet(backendId, 'Directory Backend');
        if (!directorySheet) return null;
        const data = SheetUtils.readTable(directorySheet);
        const lower = addr.toLowerCase();
        return data.rows.find((r) => String(r['email'] || '').toLowerCase() === lower) || null;
      };

      const toAppend: Record<string, any>[] = [];
      const logEntries: Array<{ event: string; attendance_type: string; cadets: string }> = [];

      const values = respSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      let rowNum = 2; // Starting row number for logging
      values.forEach((row) => {
        const email = emailIdx >= 0 ? String(row[emailIdx] || '').trim() : '';
        const name = nameIdx >= 0 ? String(row[nameIdx] || '').trim() : '';
        const flightCrosstown = flightCrosstownIdx >= 0 ? String(row[flightCrosstownIdx] || '').trim() : '';
        const tsVal = tsIdx >= 0 ? row[tsIdx] : '';
        const submittedAt = (() => {
          try { return new Date(tsVal).toISOString(); } catch { return new Date().toISOString(); }
        })();

        // Collect all selected events from "Select Event" columns
        const selectedEvents: string[] = [];
        selectEventIndices.forEach((idx) => {
          const val = String(row[idx] || '').trim();
          if (val) {
            // Events should be single values, not semicolon-separated lists
            // If we see semicolons, it's likely cadet names incorrectly in an event column
            if (val.includes(';')) {
              Log.warn(`Row ${rowNum}: "Select Event" column ${idx} contains suspicious value (looks like cadet list): "${val.substring(0, 50)}"`);
            } else {
              // Single event name
              if (!selectedEvents.includes(val)) {
                selectedEvents.push(val);
              }
            }
          }
        });

        if (selectedEvents.length === 0) {
          rowNum++;
          return;
        }

        // For each selected event, determine event type and collect relevant cadets
        selectedEvents.forEach((eventName) => {
          const key = `${email.toLowerCase()}|${eventName}|${submittedAt}`;
          if (existingKeys.has(key)) return;

          // Determine event type from event name pattern
          let eventType = '';
          if (eventName.includes('LLAB') || eventName.includes('TW-')) {
            if (eventName.includes('POC Third Hour')) {
              eventType = 'POC';
            } else if (eventName.includes('Secondary')) {
              eventType = 'Secondary';
            } else if (eventName.includes('LLAB')) {
              eventType = 'LLAB';
            } else {
              eventType = 'Mando';
            }
          } else {
            eventType = 'Other';
          }

          // Collect relevant cadet selections for this event type
          const relevantCadets: string[] = [];
          cadetColumnIndices.forEach(({ idx, title }) => {
            const titleLower = title.toLowerCase();
            const matches =
              (eventType === 'Mando' && titleLower.includes('(mando)')) ||
              (eventType === 'LLAB' && titleLower.includes('(llab)')) ||
              (eventType === 'POC' && titleLower.includes('(poc)')) ||
              (eventType === 'Secondary' && titleLower.includes('(secondary)')) ||
              (eventType === 'Other' && titleLower.includes('(all)'));

            if (matches) {
              const cadets = normalizeCadetList(row[idx]);
              cadets.forEach((c) => {
                if (!relevantCadets.includes(c)) {
                  relevantCadets.push(c);
                }
              });
            }
          });

          const cadetField = relevantCadets.join('; ');
          const cadet = lookupCadetByEmail(email);
          const submissionId = `att-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

          // Determine flight field based on event type
          let flightValue = '';
          if (eventType === 'Mando' || eventType === 'LLAB') {
            // For Mando/LLAB, use the selected flight (Alpha-Foxtrot, Trine, Valparaiso)
            flightValue = flightCrosstown || cadet?.flight || '';
          } else if (eventType === 'Secondary') {
            flightValue = 'Secondary';
          } else if (eventType === 'POC') {
            flightValue = 'POC Third Hour';
          } else if (eventType === 'Other') {
            flightValue = 'Other';
          }

          const backendRow = {
            submission_id: submissionId,
            submitted_at: submittedAt,
            event: eventName,
            attendance_type: 'P',
            email,
            name,
            flight: flightValue,
            cadets: cadetField,
          };

          toAppend.push(backendRow);
          logEntries.push({
            event: eventName,
            attendance_type: 'P',
            cadets: cadetField,
          });

          // Log first few entries for debugging
          if (toAppend.length <= 3) {
            Log.info(`Row ${rowNum} Event: "${eventName}", Cadets: "${cadetField.substring(0, 50)}", Email: ${email}, Name: ${name}`);
          }
        });
        
        rowNum++;
      });

      if (!toAppend.length) {
        Log.info('No unprocessed attendance responses found.');
        return;
      }

      SheetUtils.appendRows(backendSheet, toAppend);
      
      // Apply each log entry to update the attendance matrix
      logEntries.forEach((entry) => {
        AttendanceService.applyAttendanceLogEntry(entry);
      });

      applyAttendanceBackendFormatting();

      Log.info(`Processed attendance form backlog: appended ${toAppend.length} event rows, updated matrix.`);
    } catch (err) {
      Log.warn(`Failed to process attendance form backlog: ${err}`);
      throw err;
    }
  }

    function applyAttendanceBackendFormatting() {
        const sheet = Config.getBackendSheet('Attendance Backend');

      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h || '').trim());
      const flightCol = headers.indexOf('flight') + 1;
      if (flightCol <= 0) return;

      const startRow = 3; // data starts after header rows
      const lastRow = Math.max(startRow, sheet.getLastRow());
      const numRows = Math.max(1, lastRow - startRow + 1);
      const dataRange = sheet.getRange(startRow, 1, numRows, sheet.getLastColumn());

      const columnToLetter = (col: number) => {
        let temp = '';
        let n = col;
        while (n > 0) {
          const rem = (n - 1) % 26;
          temp = String.fromCharCode(65 + rem) + temp;
          n = Math.floor((n - 1) / 26);
        }
        return temp;
      };

      // Clear existing rules to avoid duplicates.
      sheet.clearConditionalFormatRules();

      const palette: Record<string, string> = {
        Alpha: '#E3F2FD',
        Bravo: '#FCE4EC',
        Charlie: '#F3E5F5',
        Delta: '#E8F5E9',
        Echo: '#FFF3E0',
        Foxtrot: '#E0F7FA',
        Abroad: '#ECEFF1',
        Trine: '#FFFDE7',
        Valparaiso: '#EDE7F6',
      };

      const flightColLetter = columnToLetter(flightCol);
      const rules = Object.entries(palette).map(([flight, color]) =>
        SpreadsheetApp.newConditionalFormatRule()
          .whenFormulaSatisfied(`=$${flightColLetter}${startRow}="${flight}"`)
          .setBackground(color)
          .setRanges([dataRange])
          .build(),
      );

      try {
        sheet.setConditionalFormatRules(rules);
      } catch (err) {
        Log.warn(`Unable to set conditional formatting on Attendance Backend: ${err}`);
      }
    }


  function ensureFormTrigger(handlerName: string, formId: string) {
    if (!formId) {
      Log.warn(`Cannot create form trigger for handler=${handlerName}: formId missing`);
      return;
    }

    const triggers = ScriptApp.getProjectTriggers();
    const matching = triggers.filter((t) => t.getHandlerFunction() === handlerName);
    const alreadyCorrect = matching.some((t) => {
      try {
        return t.getTriggerSourceId && t.getTriggerSourceId() === formId;
      } catch {
        return false;
      }
    });
    if (alreadyCorrect) return;

    // Clean up stale triggers for the same handler so we don't keep firing against old/deleted forms.
    matching.forEach((t) => {
      try {
        const sourceId = t.getTriggerSourceId?.();
        if (sourceId && sourceId !== formId) {
          Log.warn(`Deleting stale trigger for handler=${handlerName} sourceId=${sourceId}`);
          ScriptApp.deleteTrigger(t);
        }
      } catch {
        // Ignore; we'll create a new correct trigger below.
      }
    });

    Log.info(`Creating form submit trigger for handler=${handlerName} formId=${formId}`);
    ScriptApp.newTrigger(handlerName).forForm(formId).onFormSubmit().create();
  }

  function normalizeResponseSheetsForForms(
    spreadsheetId: string,
    forms: Array<{ formId: string; desiredSheetName: string }>,
  ) {
    const ss = SpreadsheetApp.openById(spreadsheetId);
    const desiredByFormId = new Map(forms.map((f) => [f.formId, f.desiredSheetName] as const));

    const responseishSheets = ss
      .getSheets()
      .filter((s) => RESPONSE_SHEET_REGEX.test(s.getName()) || Array.from(desiredByFormId.values()).includes(s.getName()));

    // Group response(-ish) sheets by linked form ID, when present.
    const sheetsByFormId = new Map<string, GoogleAppsScript.Spreadsheet.Sheet[]>();
    const unlinked: GoogleAppsScript.Spreadsheet.Sheet[] = [];
    responseishSheets.forEach((sheet) => {
      let formId: string | null = null;
      try {
        formId = extractFormIdFromUrl(sheet.getFormUrl() || '');
      } catch {
        formId = null;
      }
      if (!formId) {
        unlinked.push(sheet);
        return;
      }
      const arr = sheetsByFormId.get(formId) || [];
      arr.push(sheet);
      sheetsByFormId.set(formId, arr);
    });

    // For each known SHAMROCK form, ensure its linked response sheet has the desired name.
    forms.forEach(({ formId, desiredSheetName }) => {
      const linked = sheetsByFormId.get(formId) || [];
      if (linked.length === 0) {
        Log.warn(`No response sheet currently linked to formId=${formId} to rename to '${desiredSheetName}'`);
        return;
      }

      // Prefer a sheet already named correctly.
      const primary = linked.find((s) => s.getName() === desiredSheetName) || linked[0];
      if (primary.getName() !== desiredSheetName) {
        Log.info(`Renaming linked response sheet ${primary.getName()} -> ${desiredSheetName} (formId=${formId})`);
        try {
          primary.setName(desiredSheetName);
        } catch (err) {
          Log.warn(`Unable to rename response sheet to '${desiredSheetName}'. Error: ${err}`);
        }
      }

      // Any other linked sheets for the same form are likely historical destination churn; archive their names.
      linked
        .filter((s) => s.getSheetId() !== primary.getSheetId())
        .forEach((s) => {
          if (/^Archived - /i.test(s.getName())) return;
          const archivedName = `Archived - ${desiredSheetName} (${s.getName()})`;
          try {
            Log.warn(`Archiving extra linked response sheet ${s.getName()} -> ${archivedName} (formId=${formId})`);
            s.setName(archivedName);
          } catch (err) {
            Log.warn(`Unable to archive response sheet ${s.getName()}. Error: ${err}`);
          }
        });
    });

    // For unlinked "Form Responses" sheets, just archive them so they stop looking active.
    unlinked.forEach((s) => {
      if (!RESPONSE_SHEET_REGEX.test(s.getName())) return;
      const archivedName = `Archived - ${s.getName()}`;
      try {
        Log.warn(`Archiving unlinked response sheet ${s.getName()} -> ${archivedName}`);
        s.setName(archivedName);
      } catch {
        // Ignore name collisions or protected states.
      }
    });
  }

  function ensureSpreadsheetTrigger(handlerName: string, spreadsheetId: string, event: 'open' | 'edit') {
    if (!spreadsheetId) {
      Log.warn(`Cannot create ${event} trigger for ${handlerName}: spreadsheetId missing.`);
      return;
    }
    const triggers = ScriptApp.getProjectTriggers();
    const exists = triggers.some((t) => t.getHandlerFunction() === handlerName && t.getTriggerSourceId?.() === spreadsheetId);
    if (exists) return;
    Log.info(`Creating ${event} trigger for handler=${handlerName} spreadsheet=${spreadsheetId}`);
    const builder = ScriptApp.newTrigger(handlerName).forSpreadsheet(spreadsheetId);
    if (event === 'open') {
      builder.onOpen().create();
    } else {
      builder.onEdit().create();
    }
  }

  function ensureTimeTrigger(handlerName: string, weekDay: GoogleAppsScript.Base.Weekday, hour: number) {
    const triggers = ScriptApp.getProjectTriggers();
    const exists = triggers.some((t) => t.getHandlerFunction() === handlerName && t.getTriggerSource() === ScriptApp.TriggerSource.CLOCK);
    if (exists) return;
    Log.info(`Creating time trigger handler=${handlerName} day=${weekDay} hour=${hour}`);
    ScriptApp.newTrigger(handlerName).timeBased().onWeekDay(weekDay).atHour(hour).create();
  }

  function ensurePeriodicTrigger(handlerName: string, intervalMinutes: number) {
    const triggers = ScriptApp.getProjectTriggers();
    const exists = triggers.some((t) => t.getHandlerFunction() === handlerName && t.getTriggerSource() === ScriptApp.TriggerSource.CLOCK);
    if (exists) return;
    Log.info(`Creating periodic trigger handler=${handlerName} interval=${intervalMinutes}min`);
    ScriptApp.newTrigger(handlerName).timeBased().everyMinutes(intervalMinutes).create();
  }

  function ensureDailyTrigger(handlerName: string) {
    const triggers = ScriptApp.getProjectTriggers();
    const exists = triggers.some((t) => t.getHandlerFunction() === handlerName && t.getTriggerSource() === ScriptApp.TriggerSource.CLOCK);
    if (exists) return;
    Log.info(`Creating daily trigger handler=${handlerName}`);
    ScriptApp.newTrigger(handlerName).timeBased().everyDays(1).atHour(3).create();
  }

  // Deletes all installable triggers, then reinstalls the canonical SHAMROCK triggers for forms and spreadsheets.
  export function reinstallAllTriggers() {
    ProgressService.report({
      title: 'Removing stale SHAMROCK triggers',
      detail: 'Inspecting installed triggers and clearing obsolete or duplicate SHAMROCK handlers.',
      hint: 'The supported trigger set is recreated immediately after cleanup.',
      percent: 35,
      step: 1,
      totalSteps: 2,
    });
    Log.info('Reinstalling all installable triggers');

    // Clear existing triggers first.
    ScriptApp.getProjectTriggers().forEach((t) => {
      try {
        ScriptApp.deleteTrigger(t);
      } catch (err) {
        Log.warn(`Unable to delete trigger ${t.getUniqueId?.() || ''}: ${err}`);
      }
    });

    // Recreate spreadsheet triggers. Frontend onOpen is intentionally a no-op;
    // backend onOpen adds the admin menu for anyone with access to that sheet.
    const frontendId = Config.getFrontendId();
    const backendId = Config.getBackendId();
    const managementId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_MANAGEMENT_SPREADSHEET_ID);
    ensureSpreadsheetTrigger('onFrontendOpen', frontendId, 'open');
    ensureSpreadsheetTrigger('onFrontendEdit', frontendId, 'edit');
    ensureSpreadsheetTrigger('onBackendOpen', backendId, 'open');
    ensureSpreadsheetTrigger('onBackendEdit', backendId, 'edit');
    ensureSpreadsheetTrigger('onExcusalsManagementEdit', managementId, 'edit');

    // Time-based trigger: reconcile frontend Directory edits every 10 minutes (handles edits by unauthorized users).
    ensurePeriodicTrigger('reconcilePendingDirectoryEdits', 10);
    ensureDailyTrigger('cleanupExpiredTransitionArchivesV2');

    // Recreate form submit triggers for attendance/excusal/directory.
    const attendanceFormId = Config.getScriptProperty(Config.PROPERTY_KEYS.ATTENDANCE_FORM_ID);
    const excusalFormId = Config.getScriptProperty(Config.PROPERTY_KEYS.EXCUSAL_REQUEST_FORM_ID);
    const directoryFormId = Config.getScriptProperty(Config.PROPERTY_KEYS.CADET_DIRECTORY_FORM_ID);

    if (attendanceFormId) ensureFormTrigger('onAttendanceFormSubmit', attendanceFormId);
    else Log.warn('Cannot reinstall attendance form trigger: ATTENDANCE_FORM_ID missing. Run setup first.');

    if (excusalFormId) ensureFormTrigger('onExcusalsFormSubmit', excusalFormId);
    else Log.warn(`${Config.PROPERTY_KEYS.EXCUSAL_REQUEST_FORM_ID} missing; cannot reinstall excusals form trigger. Run setup first.`);

    if (directoryFormId) ensureFormTrigger('onDirectoryFormSubmit', directoryFormId);
    else Log.warn(`${Config.PROPERTY_KEYS.CADET_DIRECTORY_FORM_ID} missing; cannot reinstall directory form trigger. Run setup first.`);

    // Time-driven reminders
    ensureTimeTrigger('sendWeeklyMandoExcusedSummary', ScriptApp.WeekDay.THURSDAY, 5);
    ensureTimeTrigger('sendWeeklyLlabExcusedSummary', ScriptApp.WeekDay.TUESDAY, 12);
    ensureTimeTrigger('sendWeeklyUnexcusedSummary', ScriptApp.WeekDay.SUNDAY, 19);
    ProgressService.report({
      title: 'Supported triggers installed',
      detail: 'Form, workbook, reconciliation, cleanup, and weekly notification automations now point to current resources.',
      percent: 90,
      step: 2,
      totalSteps: 2,
    });
  }

  function removeDefaultSheetIfPresent(spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet, allowedNames: Set<string>) {
    const defaultSheet = spreadsheet.getSheetByName('Sheet1');
    if (defaultSheet && !allowedNames.has('Sheet1')) {
      // Only remove if there is more than one sheet to avoid deleting the last sheet in a spreadsheet.
      if (spreadsheet.getSheets().length > 1) {
        Log.info(`Removing default sheet 'Sheet1' from spreadsheet=${spreadsheet.getId()}`);
        spreadsheet.deleteSheet(defaultSheet);
      } else {
        Log.warn(`Default sheet 'Sheet1' present but is the only sheet; skipping delete in spreadsheet=${spreadsheet.getId()}`);
      }
    }
  }

  function ensureForm(
    kind: 'attendance' | 'excusals' | 'directory',
    name: string,
    propertyKey: string,
    destinationSpreadsheetId?: string,
    opts?: { syncQuestions?: boolean },
  ): Types.EnsureFormResult {
    Log.info(`Ensuring form kind=${kind}`);
    const existingId = Config.getScriptProperty(propertyKey);
    let form: GoogleAppsScript.Forms.Form | null = null;
    let created = false;

    if (existingId) {
      try {
        form = FormApp.openById(existingId);
        Log.info(`Found existing form id=${existingId}`);
      } catch (err) {
        Log.warn(`Stored form id invalid for key=${propertyKey}; creating new. Error: ${err}`);
      }
    }

    if (!form) {
      form = FormApp.create(name);
      created = true;
      Config.setScriptProperty(propertyKey, form.getId());
      Log.info(`Created form name=${name} id=${form.getId()}`);
    }

    // Keep form title stable (helps ops/debugging).
    try {
      if (form.getTitle() !== name) form.setTitle(name);
    } catch (err) {
      Log.warn(`Unable to set form title. Error: ${err}`);
    }

    try {
      if (kind === 'excusals') {
        form.setDescription(
          [
            'If you do not use the same email as the one in the directory (your school email) your excusal will not automatically be tracked.',
            'Please ensure you have properly selected an event and use the right email.',
          ].join('\n'),
        );
      }
    } catch (err) {
      Log.warn(`Unable to set form description. Error: ${err}`);
    }

    // Enforce responder email collection and login requirement (verified identity).
    form.setCollectEmail(true);
    try {
      form.setRequireLogin(true);
    } catch (err) {
      // setRequireLogin is not supported for consumer accounts; log and continue.
      Log.warn(`setRequireLogin not supported in this environment; continuing without it. Error: ${err}`);
    }

    // Response edit policy per form type.
    try {
      if (kind === 'directory') {
        form.setAllowResponseEdits(true);
      } else {
        form.setAllowResponseEdits(false);
      }
    } catch (err) {
      Log.warn(`setAllowResponseEdits not supported in this environment; continuing without it. Error: ${err}`);
    }

    // Route responses into the backend spreadsheet when provided, with retries.
    let destinationConfigured = false;
    if (destinationSpreadsheetId) {
      const currentDestinationId = getFormDestinationSpreadsheetId(form);
      if (currentDestinationId && currentDestinationId === destinationSpreadsheetId) {
        destinationConfigured = true;
      } else {
        if (currentDestinationId && currentDestinationId !== destinationSpreadsheetId) {
          Log.warn(
            `Form destination differs from desired; updating. current=${currentDestinationId} desired=${destinationSpreadsheetId} formId=${form.getId()}`,
          );
        }

        const attemptSetDestination = () => {
        try {
          form.setDestination(FormApp.DestinationType.SPREADSHEET, destinationSpreadsheetId);
          return true;
        } catch (err) {
          Log.warn(`Unable to set form destination to spreadsheet=${destinationSpreadsheetId}. Error: ${err}`);
          return false;
        }
      };

        // Only set destination when needed; retry to handle transient failures.
        for (let i = 0; i < 3 && !destinationConfigured; i++) {
          if (attemptSetDestination()) {
            destinationConfigured = true;
            break;
          }
          Utilities.sleep(500);
        }
      }
    }

    // Note: Built-in "email a copy of responses" setting is not reliably controllable via Apps Script.
    // Future: implement onFormSubmit email receipt as part of the form handler.
    if (kind === 'directory') {
      try {
        form.setConfirmationMessage(
          'Thanks! Please save your response edit link from the confirmation screen so you can update your information later.',
        );
      } catch (err) {
        Log.warn(`Unable to set confirmation message. Error: ${err}`);
      }
    }

    // Seed/refresh questions unless the caller is about to do a dedicated rebuild.
    if (opts?.syncQuestions !== false) {
      if (kind === 'attendance') FormService.ensureAttendanceForm(form);
      if (kind === 'excusals') FormService.ensureExcusalsForm(form);
      if (kind === 'directory') FormService.ensureDirectoryForm(form);
    }

    // Ensure the real response sheet exists and is named correctly (avoid dummy placeholders).
    if (destinationSpreadsheetId) {
      const desired =
        kind === 'attendance'
          ? Config.RESOURCE_NAMES.ATTENDANCE_FORM_SHEET
          : kind === 'excusals'
          ? Config.RESOURCE_NAMES.EXCUSALS_FORM_SHEET
          : Config.RESOURCE_NAMES.DIRECTORY_FORM_SHEET;
      ensureResponseSheetForForm(form, desired, destinationSpreadsheetId);
    }

    return {
      kind,
      id: form.getId(),
      created,
      url: form.getEditUrl(),
    };
  }

  function findLinkedResponseSheet(
    spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet,
    formId: string,
  ): GoogleAppsScript.Spreadsheet.Sheet | null {
    return spreadsheet.getSheets().find((sheet) => {
      try {
        return extractFormIdFromUrl(sheet.getFormUrl() || '') === formId;
      } catch {
        return false;
      }
    }) || null;
  }

  function uniqueSheetName(spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet, desired: string): string {
    const maxLength = 100;
    const base = desired.slice(0, maxLength);
    if (!spreadsheet.getSheetByName(base)) return base;
    let suffix = 2;
    while (suffix < 1000) {
      const suffixText = ` ${suffix}`;
      const candidate = `${desired.slice(0, maxLength - suffixText.length)}${suffixText}`;
      if (!spreadsheet.getSheetByName(candidate)) return candidate;
      suffix += 1;
    }
    throw new Error(`Unable to allocate a unique response archive sheet name for '${desired}'`);
  }

  interface FreshSheetProperties {
    sheetId: number;
    title: string;
    index?: number;
    hidden?: boolean;
    gridProperties?: { rowCount?: number; columnCount?: number; frozenRowCount?: number };
  }

  interface AttendanceFormRebuildState {
    id: string;
    spreadsheetId: string;
    formId: string;
    desiredSheetName: string;
    archivedSheetName: string;
    priorSheetIds: number[];
    newResponseSheetId?: number;
    attempts: number;
    createdAt: string;
  }

  const ATTENDANCE_FORM_REBUILD_CONTINUATION_HANDLER = 'finalizeAttendanceFormRebuild';

  function getFreshSheetProperties(spreadsheetId: string): FreshSheetProperties[] {
    const service = (globalThis as any).Sheets?.Spreadsheets;
    if (!service?.get) {
      throw new Error('Sheets advanced service is required to verify a newly linked Form response tab');
    }
    const response = service.get(spreadsheetId, {
      fields: 'sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount,frozenRowCount)))',
    });
    return (response?.sheets || [])
      .map((sheet: any) => sheet?.properties as FreshSheetProperties)
      .filter((properties: FreshSheetProperties | undefined): properties is FreshSheetProperties => (
        Boolean(properties) && typeof properties?.sheetId === 'number'
      ));
  }

  function waitForNewResponseSheetMetadata(
    spreadsheetId: string,
    priorSheetIds: Set<number>,
    timeoutMs = 15000,
  ): FreshSheetProperties | null {
    const startedAt = Date.now();
    let attempt = 0;
    while (Date.now() - startedAt < timeoutMs) {
      if (attempt > 0) Utilities.sleep(2000);
      const candidates = getFreshSheetProperties(spreadsheetId).filter((sheet) => (
        !priorSheetIds.has(sheet.sheetId) && RESPONSE_SHEET_REGEX.test(sheet.title)
      ));
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) {
        throw new Error(
          `Multiple new Form response tabs appeared during Attendance rebuild: ${candidates.map((sheet) => `${sheet.title} (${sheet.sheetId})`).join(', ')}`,
        );
      }

      attempt += 1;
      if (attempt % 5 === 0) {
        Log.info(
          `Attendance form: waiting for linked response sheet elapsedMs=${Date.now() - startedAt} attempts=${attempt}`,
        );
      }
    }
    return null;
  }

  function renameResponseSheetViaSheetsApi(
    spreadsheetId: string,
    sheetId: number,
    title: string,
  ) {
    const service = (globalThis as any).Sheets?.Spreadsheets;
    if (!service?.batchUpdate) {
      throw new Error('Sheets advanced service is required to rename a newly linked Form response tab');
    }
    service.batchUpdate({
      requests: [{
        updateSheetProperties: {
          properties: {
            sheetId,
            title,
            hidden: false,
            gridProperties: { frozenRowCount: 1 },
          },
          fields: 'title,hidden,gridProperties.frozenRowCount',
        },
      }],
    }, spreadsheetId);
  }

  function responseSheetDiagnosticsViaSheetsApi(
    spreadsheetId: string,
    sheetTitle: string,
    rowCount: number,
  ) {
    const valuesService = (globalThis as any).Sheets?.Spreadsheets?.Values;
    if (!valuesService?.get) {
      throw new Error('Sheets advanced service is required to inspect the new Form response headers');
    }
    const escapedTitle = sheetTitle.replace(/'/g, "''");
    const response = valuesService.get(spreadsheetId, `'${escapedTitle}'!1:1`, {
      majorDimension: 'ROWS',
      valueRenderOption: 'FORMATTED_VALUE',
    });
    const headers = ((response?.values || [])[0] || []).map((header: unknown) => String(header || '').trim());
    const counts = new Map<string, number>();
    headers.forEach((header: string) => {
      if (!header) return;
      counts.set(header, (counts.get(header) || 0) + 1);
    });
    const duplicates = Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      columnCount: headers.filter(Boolean).length,
      rowCount,
      uniqueHeaderCount: counts.size,
      duplicateHeaderCount: duplicates.length,
      maxHeaderOccurrences: duplicates.length ? duplicates[0][1] : 1,
      duplicateHeaders: duplicates,
    };
  }

  function loadAttendanceFormRebuildState(): AttendanceFormRebuildState | null {
    const raw = Config.getScriptProperty(Config.PROPERTY_KEYS.ATTENDANCE_FORM_REBUILD_STATE);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AttendanceFormRebuildState;
    } catch (err) {
      Log.error(`Attendance form: invalid rebuild continuation state; clearing it. Error: ${err}`);
      Config.deleteScriptProperty(Config.PROPERTY_KEYS.ATTENDANCE_FORM_REBUILD_STATE);
      return null;
    }
  }

  function saveAttendanceFormRebuildState(state: AttendanceFormRebuildState) {
    Config.setScriptProperty(Config.PROPERTY_KEYS.ATTENDANCE_FORM_REBUILD_STATE, JSON.stringify(state));
  }

  function clearAttendanceFormRebuildContinuationTriggers() {
    ScriptApp.getProjectTriggers()
      .filter((trigger) => trigger.getHandlerFunction() === ATTENDANCE_FORM_REBUILD_CONTINUATION_HANDLER)
      .forEach((trigger) => {
        try {
          ScriptApp.deleteTrigger(trigger);
        } catch (err) {
          Log.warn(`Attendance form: unable to delete rebuild continuation trigger: ${err}`);
        }
      });
  }

  function scheduleAttendanceFormRebuildContinuation() {
    clearAttendanceFormRebuildContinuationTriggers();
    ScriptApp.newTrigger(ATTENDANCE_FORM_REBUILD_CONTINUATION_HANDLER).timeBased().after(60 * 1000).create();
    Log.info('Attendance form: scheduled response-tab finalization continuation.');
  }

  function completeAttendanceFormRebuild(
    state: AttendanceFormRebuildState,
    newResponseSheet: FreshSheetProperties,
  ) {
    state.newResponseSheetId = newResponseSheet.sheetId;
    saveAttendanceFormRebuildState(state);
    renameResponseSheetViaSheetsApi(state.spreadsheetId, newResponseSheet.sheetId, state.desiredSheetName);
    const diagnostics = responseSheetDiagnosticsViaSheetsApi(
      state.spreadsheetId,
      state.desiredSheetName,
      newResponseSheet.gridProperties?.rowCount || 0,
    );
    const healthSummary =
      `Attendance response sheet health sheet='${state.desiredSheetName}' sheetId=${newResponseSheet.sheetId} `
      + `columns=${diagnostics.columnCount} rows=${diagnostics.rowCount} uniqueHeaders=${diagnostics.uniqueHeaderCount} `
      + `duplicateHeaders=${diagnostics.duplicateHeaderCount} maxHeaderOccurrences=${diagnostics.maxHeaderOccurrences}`;
    if (diagnostics.duplicateHeaderCount) {
      Log.error(healthSummary);
      throw new Error(
        `Fresh Attendance response sheet still has ${diagnostics.duplicateHeaderCount} duplicate header name(s); preserved archive='${state.archivedSheetName || 'none'}'`,
      );
    }
    Log.info(healthSummary);
    Config.deleteScriptProperty(Config.PROPERTY_KEYS.ATTENDANCE_FORM_REBUILD_STATE);
    clearAttendanceFormRebuildContinuationTriggers();
    Log.info(
      `Attendance form: rebuild finalized responseSheet='${state.desiredSheetName}' sheetId=${newResponseSheet.sheetId} `
      + `originalTitle='${newResponseSheet.title}' columns=${diagnostics.columnCount} archive='${state.archivedSheetName || 'none'}' stateId=${state.id}`,
    );
    AuditService.log({
      action: 'attendance_form_rebuild_finalize',
      actionLabel: 'Finalize Attendance Form rebuild',
      category: 'Sync & Refresh',
      result: 'ok',
      role: 'automation',
      targetSheet: state.desiredSheetName,
      source: 'Apps Script continuation',
      runId: state.id,
      metadata: {
        sheet_id: newResponseSheet.sheetId,
        original_title: newResponseSheet.title,
        archived_sheet: state.archivedSheetName,
        columns: diagnostics.columnCount,
        duplicate_headers: diagnostics.duplicateHeaderCount,
      },
    });
  }

  function tryFinalizeAttendanceFormRebuild(
    state: AttendanceFormRebuildState,
    scheduleIfPending: boolean,
  ): boolean {
    const priorSheetIds = new Set(state.priorSheetIds);
    const freshSheets = getFreshSheetProperties(state.spreadsheetId);
    const candidates = state.newResponseSheetId
      ? freshSheets.filter((sheet) => sheet.sheetId === state.newResponseSheetId)
      : freshSheets.filter((sheet) => (
          !priorSheetIds.has(sheet.sheetId)
          && (RESPONSE_SHEET_REGEX.test(sheet.title) || sheet.title === state.desiredSheetName)
        ));
    if (candidates.length > 1) {
      throw new Error(
        `Multiple new Form response tabs appeared during Attendance rebuild: ${candidates.map((sheet) => `${sheet.title} (${sheet.sheetId})`).join(', ')}`,
      );
    }
    if (candidates.length === 1) {
      completeAttendanceFormRebuild(state, candidates[0]);
      return true;
    }

    if (scheduleIfPending) {
      state.attempts += 1;
      saveAttendanceFormRebuildState(state);
      if (state.attempts <= 15) {
        scheduleAttendanceFormRebuildContinuation();
        ProgressService.background(
          'Attendance Form finalization will continue',
          'Google is still creating or backfilling the new response tab, so SHAMROCK saved a checkpoint and scheduled another verification.',
          'Do not start a second rebuild. The continuation will rename and verify the exact linked response tab when it becomes available.',
        );
        Log.info(
          `Attendance form: response tab is still being created/backfilled; continuation scheduled stateId=${state.id} attempt=${state.attempts}`,
        );
      } else {
        clearAttendanceFormRebuildContinuationTriggers();
        Log.error(
          `Attendance form: response-tab finalization remains pending after ${state.attempts} attempts; stateId=${state.id}. Rerun the menu action to retry finalization without rebuilding.`,
        );
      }
    }
    return false;
  }

  export function finalizeAttendanceFormRebuild() {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const state = loadAttendanceFormRebuildState();
      if (!state) {
        clearAttendanceFormRebuildContinuationTriggers();
        Log.info('Attendance form: no pending rebuild finalization state found.');
        return;
      }
      tryFinalizeAttendanceFormRebuild(state, true);
    } finally {
      lock.releaseLock();
    }
  }

  function responseSheetDiagnostics(sheet: GoogleAppsScript.Spreadsheet.Sheet) {
    const columnCount = sheet.getLastColumn();
    const rowCount = sheet.getLastRow();
    const headers = columnCount
      ? sheet.getRange(1, 1, 1, columnCount).getValues()[0].map((header) => String(header || '').trim())
      : [];
    const counts = new Map<string, number>();
    headers.forEach((header) => {
      if (!header) return;
      counts.set(header, (counts.get(header) || 0) + 1);
    });
    const duplicates = Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      columnCount,
      rowCount,
      uniqueHeaderCount: counts.size,
      duplicateHeaderCount: duplicates.length,
      maxHeaderOccurrences: duplicates.length ? duplicates[0][1] : 1,
      duplicateHeaders: duplicates,
    };
  }

  function logAttendanceResponseSheetHealth(sheet?: GoogleAppsScript.Spreadsheet.Sheet) {
    const target = sheet || Config.getBackendSheet(Config.RESOURCE_NAMES.ATTENDANCE_FORM_SHEET);
    const diagnostics = responseSheetDiagnostics(target);
    const summary =
      `Attendance response sheet health sheet='${target.getName()}' columns=${diagnostics.columnCount} rows=${diagnostics.rowCount} `
      + `uniqueHeaders=${diagnostics.uniqueHeaderCount} duplicateHeaders=${diagnostics.duplicateHeaderCount} `
      + `maxHeaderOccurrences=${diagnostics.maxHeaderOccurrences}`;
    if (diagnostics.duplicateHeaderCount) Log.warn(summary);
    else Log.info(summary);
    return diagnostics;
  }

  function rebuildAttendanceFormWithFreshResponseSheet(
    form: GoogleAppsScript.Forms.Form,
    destinationSpreadsheetId: string,
  ) {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);

    const desiredSheetName = Config.RESOURCE_NAMES.ATTENDANCE_FORM_SHEET;
    let wasAcceptingResponses: boolean | null = null;
    let archivedSheetName = '';

    try {
      const pendingState = loadAttendanceFormRebuildState();
      if (pendingState) {
        if (pendingState.attempts > 15) pendingState.attempts = 0;
        if (!tryFinalizeAttendanceFormRebuild(pendingState, true)) {
          Log.warn(
            `Attendance form: rebuild state ${pendingState.id} is still waiting for its response tab; no second rebuild was started.`,
          );
        }
        return;
      }

      const formId = form.getId();
      wasAcceptingResponses = form.isAcceptingResponses();
      const spreadsheet = SpreadsheetApp.openById(destinationSpreadsheetId);
      // Verify the Advanced Sheets API before any destructive form mutation and
      // snapshot sheet IDs through its uncached metadata surface.
      const priorSheetIds = new Set(getFreshSheetProperties(destinationSpreadsheetId).map((sheet) => sheet.sheetId));
      const originalDestinationId = getFormDestinationSpreadsheetId(form);
      const priorResponseSheet = findLinkedResponseSheet(spreadsheet, formId)
        || (originalDestinationId === destinationSpreadsheetId ? spreadsheet.getSheetByName(desiredSheetName) : null);

      form.setAcceptingResponses(false);
      if (originalDestinationId) form.removeDestination();

      if (priorResponseSheet) {
        const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
        archivedSheetName = uniqueSheetName(spreadsheet, `Archived - ${desiredSheetName} ${stamp}`);
        priorResponseSheet.setName(archivedSheetName);
        priorResponseSheet.hideSheet();
        try {
          priorResponseSheet.protect().setDescription(`${archivedSheetName} preserved raw form responses`).setWarningOnly(true);
        } catch (err) {
          Log.warn(`Unable to add warning protection to attendance response archive '${archivedSheetName}': ${err}`);
        }
        Log.info(
          `Attendance form: preserved prior linked response sheet as '${archivedSheetName}' rows=${priorResponseSheet.getLastRow()} columns=${priorResponseSheet.getLastColumn()}`,
        );
      }

      FormService.rebuildAttendanceForm(form);
      form.setDestination(FormApp.DestinationType.SPREADSHEET, destinationSpreadsheetId);

      const state: AttendanceFormRebuildState = {
        id: Utilities.getUuid(),
        spreadsheetId: destinationSpreadsheetId,
        formId,
        desiredSheetName,
        archivedSheetName,
        priorSheetIds: Array.from(priorSheetIds),
        attempts: 0,
        createdAt: new Date().toISOString(),
      };
      saveAttendanceFormRebuildState(state);

      const immediateSheet = waitForNewResponseSheetMetadata(destinationSpreadsheetId, priorSheetIds);
      if (immediateSheet) {
        completeAttendanceFormRebuild(state, immediateSheet);
      } else {
        tryFinalizeAttendanceFormRebuild(state, true);
      }
    } catch (err) {
      Log.error(`Attendance form: protected rebuild failed: ${err}`);
      try {
        if (getFormDestinationSpreadsheetId(form) !== destinationSpreadsheetId) {
          form.setDestination(FormApp.DestinationType.SPREADSHEET, destinationSpreadsheetId);
          Log.warn('Attendance form: restored backend response destination after rebuild failure');
        }
      } catch (recoveryErr) {
        Log.error(`Attendance form: unable to restore response destination after rebuild failure: ${recoveryErr}`);
      }
      throw err;
    } finally {
      if (wasAcceptingResponses !== null) {
        try {
          form.setAcceptingResponses(wasAcceptingResponses);
        } catch (err) {
          Log.error(`Attendance form: unable to restore accepting-responses state=${wasAcceptingResponses}: ${err}`);
        }
      }
      lock.releaseLock();
    }
  }

  export function applyFrontendFormatting() {
    const frontendId = Config.getFrontendId();
    const stages: Array<{ title: string; detail: string; technicalLabel: string; run: () => void }> = [
      {
        title: 'Temporarily opening managed ranges',
        detail: 'Clearing SHAMROCK-managed protections so table and format repairs can run cleanly.',
        technicalLabel: 'clear managed protections',
        run: () => ProtectionService.clearManagedFrontendProtections(frontendId),
      },
      {
        title: 'Applying the base frontend layout',
        detail: 'Refreshing sheet chrome, widths, visible headers, and standard cell presentation.',
        technicalLabel: 'apply pre-table frontend formatting',
        run: () => FrontendFormattingService.applyAll(frontendId),
      },
      {
        title: 'Checking Google Sheets tables',
        detail: 'Ensuring each primary frontend surface has the expected table object and style.',
        technicalLabel: 'ensure frontend tables',
        run: () => ensureFrontendTables(frontendId),
      },
      {
        title: 'Restoring dropdown and validation rules',
        detail: 'Reapplying Data Legend-backed rules after table updates.',
        technicalLabel: 'reapply validations after table ensure',
        run: () => FrontendFormattingService.applyValidations(frontendId),
      },
      {
        title: 'Finishing table-aware styling',
        detail: 'Applying alignment, text treatment, and typed-cell-safe finishing passes.',
        technicalLabel: 'apply post-table formatting',
        run: () => FrontendFormattingService.applyPostTableFormatting(frontendId),
      },
      {
        title: 'Restoring frontend protections',
        detail: 'Locking the managed user-facing ranges again after formatting is complete.',
        technicalLabel: 'apply frontend protections',
        run: () => ProtectionService.applyFrontendProtections(frontendId),
      },
    ];

    stages.forEach((stage, index) => {
      ProgressService.report({
        title: stage.title,
        detail: stage.detail,
        hint: 'Formatting stages are ordered to remain compatible with Google Sheets table and typed-column constraints.',
        percent: 12 + Math.round((index / stages.length) * 78),
        step: index + 1,
        totalSteps: stages.length,
      });
      runFrontendFormattingStage(stage.technicalLabel, stage.run);
    });
  }

  function runFrontendFormattingStage(label: string, fn: () => void) {
    const started = Date.now();
    Log.info(`applyFrontendFormatting stage start: ${label}`);
    try {
      fn();
      Log.info(`applyFrontendFormatting stage ok: ${label} durationMs=${Date.now() - started}`);
    } catch (err) {
      Log.error(`applyFrontendFormatting stage failed: ${label} durationMs=${Date.now() - started} error="${err}"`);
      throw err;
    }
  }

  function ensureFrontendTables(frontendId: string) {
    if (!frontendId) return;
    FRONTEND_TABLE_SHEETS.forEach((name) => ensureTableForSheet(frontendId, name, name));
  }

  export function rebuildDashboard() {
    const frontendId = Config.getFrontendId();
    if (isFrontendFormattingDisabled()) {
      Log.info(`${Config.PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_FORMATTING}=true; skipping dashboard rebuild.`);
      return;
    }
    ProgressService.report({
      title: 'Rebuilding the Dashboard',
      detail: 'Refreshing quick links, roster summaries, attendance highlights, and the mobile-friendly layout.',
      percent: 45,
    });
    FrontendFormattingService.applyDashboardOnly(frontendId);
  }

  export function reapplyFrontendProtections() {
    const frontendId = Config.getFrontendId();
    ProgressService.report({
      title: 'Reapplying frontend protections',
      detail: 'Checking managed ranges and restoring the intended editor access.',
      percent: 55,
    });
    ProtectionService.applyFrontendProtections(frontendId);
  }

  export function toggleFrontendFormatting() {
    const current = Config.getBooleanScriptProperty(Config.PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_FORMATTING);
    const next = current ? '' : 'true';
    ProgressService.report({
      title: next === 'true' ? 'Disabling automatic frontend formatting' : 'Enabling automatic frontend formatting',
      detail: 'Saving the presentation preference in Script Properties for future refreshes.',
      percent: 70,
    });
    Config.setScriptProperty(Config.PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_FORMATTING, next);
    const status = next === 'true' ? 'OFF (disabled)' : 'ON (enabled)';
    const msg = `Frontend formatting is now ${status}.`;
    try {
      SpreadsheetApp.getUi().alert(msg);
    } catch (err) {
      Log.info(msg);
    }
  }

  function reorderSheets(spreadsheetId: string, desiredOrder: string[]) {
    if (!spreadsheetId) {
      Log.warn('Cannot reorder sheets: spreadsheetId missing.');
      return;
    }
    const ss = SpreadsheetApp.openById(spreadsheetId);
    let position = 1;

    const moveSheet = (sheet: GoogleAppsScript.Spreadsheet.Sheet) => {
      try {
        ss.setActiveSheet(sheet);
        ss.moveActiveSheet(position++);
      } catch (err) {
        Log.warn(`Unable to move sheet ${sheet.getName()} in spreadsheet=${spreadsheetId}: ${err}`);
      }
    };

    desiredOrder.forEach((name) => {
      const sheet = ss.getSheetByName(name);
      if (sheet) moveSheet(sheet);
    });

    ss.getSheets()
      .filter((s) => !desiredOrder.includes(s.getName()))
      .forEach((sheet) => moveSheet(sheet));
  }

  export function toggleFrontendColumnWidths() {
    const current = Config.getBooleanScriptProperty(Config.PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_COLUMN_WIDTHS);
    const next = current ? '' : 'true';
    ProgressService.report({
      title: next === 'true' ? 'Preserving manual column widths' : 'Enabling standard column widths',
      detail: 'Saving the column-width preference in Script Properties for future formatting runs.',
      percent: 70,
    });
    Config.setScriptProperty(Config.PROPERTY_KEYS.DISABLE_MAIN_WORKBOOK_COLUMN_WIDTHS, next);
    const status = next === 'true' ? 'OFF (disabled)' : 'ON (enabled)';
    const msg = `Frontend column width formatting is now ${status}.`;
    try {
      SpreadsheetApp.getUi().alert(msg);
    } catch (err) {
      Log.info(msg);
    }
  }

  export function pauseAutomations(reason = 'manual pause') {
    ProgressService.report({
      title: 'Pausing automated propagation',
      detail: 'Saving the pause flag so edit-triggered updates wait for a later resume.',
      percent: 65,
    });
    PauseService.pause(reason);
    const msg = `Automation is now PAUSED (${PauseService.pauseInfo()}). Frontend edits will be deferred.`;
    try {
      SpreadsheetApp.getUi().alert(msg);
    } catch (err) {
      Log.info(msg);
    }
  }

  export function resumeAutomations() {
    const wasPaused = PauseService.isPaused();
    ProgressService.report({
      title: 'Re-enabling automations',
      detail: 'Clearing the pause flag before reconciling any deferred changes.',
      percent: 12,
      step: 1,
      totalSteps: 5,
    });
    PauseService.resume();

    // Batch mirror any frontend Directory edits made while paused back into the backend, then resync artifacts.
    ProgressService.report({
      title: 'Reconciling deferred Directory edits',
      detail: 'Comparing frontend changes with authoritative Directory records.',
      percent: 28,
      step: 2,
      totalSteps: 5,
    });
    const reconciliation = FrontendEditService.reconcilePendingDirectoryEdits();
    ProgressService.report({
      title: 'Publishing refreshed workbook data',
      detail: 'Syncing mapped backend tables to the frontend.',
      percent: 48,
      step: 3,
      totalSteps: 5,
    });
    SyncService.syncAllMapped();
    ProgressService.report({
      title: 'Rebuilding attendance and form choices',
      detail: 'Regenerating attendance results and current event choices.',
      percent: 68,
      step: 4,
      totalSteps: 5,
    });
    rebuildAttendanceMatrix();
    refreshAttendanceFormEventChoices();
    refreshExcusalsFormEventChoices();
    ProgressService.report({
      title: 'Finishing the frontend presentation',
      detail: 'Applying the standard formatting and protections to refreshed views.',
      percent: 86,
      step: 5,
      totalSteps: 5,
    });
    applyFrontendFormatting();

    const msg = wasPaused
      ? `Automation resumed. Applied ${reconciliation.updated} Directory updates (missing matches: ${reconciliation.missing}).`
      : 'Automation was not paused; performed refresh anyway.';
    try {
      SpreadsheetApp.getUi().alert(msg);
    } catch (err) {
      Log.info(msg);
    }
  }

  export function refreshDataLegendAndFrontend() {
    ProgressService.report({
      title: 'Refreshing canonical option lists',
      detail: 'Rebuilding attendance codes, ranks, units, and other supported choices.',
      percent: 22,
      step: 1,
      totalSteps: 3,
    });
    DataLegendService.refreshLegendFromArrays();
    ProgressService.report({
      title: 'Publishing Data Legend choices',
      detail: 'Copying the authoritative option ranges to the frontend workbook.',
      percent: 52,
      step: 2,
      totalSteps: 3,
    });
    SyncService.syncByBackendSheetName('Data Legend');
    ProgressService.report({
      title: 'Applying updated validation rules',
      detail: 'Refreshing dropdown and validation behavior that depends on the Data Legend.',
      percent: 72,
      step: 3,
      totalSteps: 3,
    });
    applyFrontendFormatting();
  }

  export function syncDirectoryBackendToFrontend() {
    ProgressService.report({
      title: 'Refreshing Directory dependencies',
      detail: 'Updating option lists and derived Leadership rows before publishing Directory.',
      percent: 18,
      step: 1,
      totalSteps: 4,
    });
    DataLegendService.refreshLegendFromArrays();
    SyncService.syncByBackendSheetName('Data Legend');
    DirectoryService.syncLeadershipBackendFromDirectory();
    ProgressService.report({
      title: 'Publishing the Directory',
      detail: 'Copying active cadet records to the protected frontend view.',
      percent: 48,
      step: 2,
      totalSteps: 4,
    });
    syncDirectoryFrontend();
    ProgressService.report({
      title: 'Refreshing the Directory presentation',
      detail: 'Restoring validations, tables, formatting, and protections.',
      percent: 70,
      step: 3,
      totalSteps: 4,
    });
    applyFrontendFormatting();
  }

  export function syncLeadershipBackendToFrontend() {
    ProgressService.report({
      title: 'Publishing Leadership',
      detail: 'Copying the current authoritative Leadership rows to the frontend.',
      percent: 55,
    });
    SyncService.syncByBackendSheetName('Leadership Backend');
  }

  export function syncDataLegendBackendToFrontend() {
    ProgressService.report({
      title: 'Publishing the Data Legend',
      detail: 'Copying option ranges to the frontend before validations are reapplied.',
      percent: 35,
      step: 1,
      totalSteps: 2,
    });
    SyncService.syncByBackendSheetName('Data Legend');
    applyFrontendFormatting();
  }

  export function syncAllBackendToFrontend() {
    ProgressService.report({
      title: 'Syncing all mapped tables',
      detail: 'Publishing each supported backend source to its frontend view.',
      percent: 32,
      step: 1,
      totalSteps: 2,
    });
    SyncService.syncAllMapped();
    ProgressService.report({
      title: 'Finishing refreshed frontend views',
      detail: 'Restoring standard formatting, validations, and protections.',
      percent: 62,
      step: 2,
      totalSteps: 2,
    });
    applyFrontendFormatting();
  }

  export function applyAttendanceBackendFormattingPublic() {
    applyAttendanceBackendFormatting();
  }

  export function syncDirectoryFrontend() {
    const frontendId = Config.getFrontendId();
    if (frontendId) DirectoryService.protectFrontendDirectory(frontendId);
    DirectoryService.syncDirectoryFrontend();
  }

  export function refreshDirectoryArtifacts(opts?: { rebuildAttendanceMatrix?: boolean; refreshAttendanceForm?: boolean }) {
    DirectoryService.syncLeadershipBackendFromDirectory();
    syncDirectoryFrontend();
    if (opts?.rebuildAttendanceMatrix) rebuildAttendanceMatrix();
    if (opts?.refreshAttendanceForm) refreshAttendanceFormChoices();
  }

  export function rebuildAttendanceMatrix() {
    const frontendId = Config.getFrontendId();
    ProgressService.report({
      title: 'Replaying attendance records',
      detail: 'Calculating the current matrix from attendance logs, excusals, events, and active cadets.',
      percent: 28,
      step: 1,
      totalSteps: 3,
    });
    AttendanceService.rebuildMatrix();
    try {
      // Re-apply Attendance header formatting and validations after matrix rebuild.
      ProgressService.report({
        title: 'Restoring Attendance rules and layout',
        detail: 'Applying headers, validation, table-aware formatting, and summary alignment.',
        percent: 62,
        step: 2,
        totalSteps: 3,
      });
      applyAttendanceHeaderFix();
      if (frontendId) {
        FrontendFormattingService.applyValidations(frontendId);
        ensureTableForSheet(frontendId, 'Attendance', 'Attendance');
        FrontendFormattingService.applyValidations(frontendId);
        FrontendFormattingService.applyPostTableFormatting(frontendId);
      }
      ProgressService.report({
        title: 'Protecting the rebuilt Attendance view',
        detail: 'Restoring managed frontend protections after the derived matrix is complete.',
        percent: 88,
        step: 3,
        totalSteps: 3,
      });
      reapplyFrontendProtections();
    } catch (err) {
      Log.warn(`fixAttendanceHeaders post-rebuild failed: ${err}`);
    }
  }

  export function refreshAttendanceForm() {
    const backendId = Config.getBackendId();
    ensureForm('attendance', Config.RESOURCE_NAMES.ATTENDANCE_FORM, Config.PROPERTY_KEYS.ATTENDANCE_FORM_ID, backendId);
    applyAttendanceBackendFormatting();
  }

  export function refreshExcusalsForm() {
    const backendId = Config.getBackendId();
    ProgressService.report({
      title: 'Opening the Excusals Form',
      detail: 'Checking the existing form without recreating its questions.',
      percent: 35,
      step: 1,
      totalSteps: 2,
    });
    // syncQuestions: false prevents a full form rebuild — only refreshes event choices.
    // A rebuild clears all items and recreates them, which creates duplicate columns
    // in the response sheet every time.
    const ensured = ensureForm('excusals', Config.RESOURCE_NAMES.EXCUSALS_FORM, Config.PROPERTY_KEYS.EXCUSAL_REQUEST_FORM_ID, backendId, { syncQuestions: false });
    const form = FormApp.openById(ensured.id);
    ProgressService.report({
      title: 'Refreshing Excusals event choices',
      detail: 'Updating selectable events from the current Events Backend definitions.',
      percent: 72,
      step: 2,
      totalSteps: 2,
    });
    FormService.refreshExcusalsFormEventChoices(form);
  }

  export function rebuildAttendanceForm() {
    const backendId = Config.getBackendId();
    ProgressService.report({
      title: 'Checking the Attendance Form',
      detail: 'Opening the current form and linked response destination.',
      percent: 22,
      step: 1,
      totalSteps: 4,
    });
    const ensured = ensureForm(
      'attendance',
      Config.RESOURCE_NAMES.ATTENDANCE_FORM,
      Config.PROPERTY_KEYS.ATTENDANCE_FORM_ID,
      backendId,
      { syncQuestions: false },
    );
    const form = FormApp.openById(ensured.id);
    ProgressService.report({
      title: 'Preserving the current response history',
      detail: 'Closing the form briefly and archiving its linked response tab before structural changes.',
      percent: 42,
      step: 2,
      totalSteps: 4,
    });
    rebuildAttendanceFormWithFreshResponseSheet(form, backendId);
    ProgressService.report({
      title: 'Verifying the fresh response destination',
      detail: 'Checking the new linked tab and saving continuation state if Google is still creating it.',
      percent: 72,
      step: 3,
      totalSteps: 4,
    });
    ProgressService.report({
      title: 'Formatting the Attendance backend',
      detail: 'Restoring the standard backend response and attendance-log presentation.',
      percent: 90,
      step: 4,
      totalSteps: 4,
    });
    applyAttendanceBackendFormatting();
  }

  export function rebuildDirectoryForm() {
    const backendId = Config.getBackendId();
    const ensured = ensureForm(
      'directory',
      Config.RESOURCE_NAMES.DIRECTORY_FORM,
      Config.PROPERTY_KEYS.CADET_DIRECTORY_FORM_ID,
      backendId,
      { syncQuestions: false },
    );
    const form = FormApp.openById(ensured.id);
    FormService.rebuildDirectoryForm(form);
  }

  export function refreshAttendanceFormChoices() {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const backendId = Config.getBackendId();
      const ensured = ensureForm(
        'attendance',
        Config.RESOURCE_NAMES.ATTENDANCE_FORM,
        Config.PROPERTY_KEYS.ATTENDANCE_FORM_ID,
        backendId,
        { syncQuestions: false },
      );
      const form = FormApp.openById(ensured.id);
      FormService.refreshAttendanceFormEventChoices(form);
      FormService.refreshAttendanceFormCadetChoices(form);
      logAttendanceResponseSheetHealth();
    } finally {
      lock.releaseLock();
    }
  }

  export function refreshAttendanceFormEventChoices() {
    refreshAttendanceFormChoices();
  }

  export function reorderFrontendSheets() {
    const frontendId = Config.getFrontendId();
    const desired = ['FAQs', 'Dashboard', 'Leadership', 'Directory', 'Attendance', 'Data Legend'];
    ProgressService.report({
      title: 'Ordering frontend sheets',
      detail: 'Moving user-facing tabs into the standard navigation order.',
      percent: 62,
    });
    reorderSheets(frontendId, desired);
  }

  export function reorderBackendSheets() {
    const backendId = Config.getBackendId();
    const desired = [
      Config.RESOURCE_NAMES.DIRECTORY_FORM_SHEET,
      Config.RESOURCE_NAMES.EXCUSALS_FORM_SHEET,
      Config.RESOURCE_NAMES.ATTENDANCE_FORM_SHEET,
      'Leadership Backend',
      'Directory Backend',
      'Attendance Matrix Backend',
      'Attendance Backend',
      'Events Backend',
      'Excusals Backend',
      'Audit Backend',
      'Data Legend',
    ];
    ProgressService.report({
      title: 'Ordering admin sheets',
      detail: 'Moving backend tabs into the standard operator order.',
      percent: 62,
    });
    reorderSheets(backendId, desired);
  }

  export function refreshExcusalsFormEventChoices() {
    const backendId = Config.getBackendId();
    const ensured = ensureForm('excusals', Config.RESOURCE_NAMES.EXCUSALS_FORM, Config.PROPERTY_KEYS.EXCUSAL_REQUEST_FORM_ID, backendId);
    const form = FormApp.openById(ensured.id);
    FormService.refreshExcusalsFormEventChoices(form);
  }

  export function refreshEventsArtifacts() {
    ProgressService.report({
      title: 'Publishing current events',
      detail: 'Syncing Events Backend definitions to their mapped surfaces.',
      percent: 16,
      step: 1,
      totalSteps: 4,
    });
    SyncService.syncByBackendSheetName('Events Backend');
    ProgressService.report({
      title: 'Rebuilding event-based attendance columns',
      detail: 'Regenerating the Attendance matrix using the refreshed event list.',
      percent: 38,
      step: 2,
      totalSteps: 4,
    });
    rebuildAttendanceMatrix();
    ProgressService.report({
      title: 'Refreshing Attendance Form choices',
      detail: 'Publishing the current event and cadet choices without recreating the full form.',
      percent: 66,
      step: 3,
      totalSteps: 4,
    });
    refreshAttendanceFormEventChoices();
    ProgressService.report({
      title: 'Finishing refreshed frontend views',
      detail: 'Applying standard validation, formatting, tables, and protections.',
      percent: 84,
      step: 4,
      totalSteps: 4,
    });
    applyFrontendFormatting();
  }

  export function showMenuHelp() {
    const lines = [
      'Sync Directory: derives cadet Leadership rows from Directory, then syncs Directory to frontend.',
      'Sync Leadership: preserves cadre/manual Leadership rows, derives cadet rows from Directory roles, then syncs to frontend.',
      'Sync Data Legend: copies backend Data Legend to frontend.',
      'Sync ALL mapped: runs Directory/Leadership/Data Legend syncs.',
      'Refresh Events + Attendance: sync events backend -> frontend artifacts and rebuild attendance matrix/form choices.',
      'Rebuild Attendance Matrix: replay attendance backend log -> frontend matrix.',
      'Rebuild Attendance Form: archive the current raw response tab, rebuild questions from backend data, and link a clean response tab.',
      'CSV exports: create Drive CSV from the specified backend table. Imports overwrite the target backend sheet (headers must match).',
      'Transition v2: archive current sheets, update roster/events, clear current-term logs/responses, rebuild forms, and keep backend rollback archives for seven days.',
      'Protections/formatting items only affect frontend presentation; data comes from backend tables.',
    ];

    const msg = lines.join('\n');
    try {
      SpreadsheetApp.getUi().alert(msg);
    } catch (err) {
      Log.info(msg);
    }
  }

  export function archiveCoreSheets() {
    const frontendId = Config.getFrontendId();
    const backendId = Config.getBackendId();
    const frontendNames = ['Leadership', 'Directory', 'Attendance'];
    const backendNames = ['Leadership Backend', 'Directory Backend', 'Attendance Backend'];

    ProgressService.report({
      title: 'Archiving core frontend sheets',
      detail: 'Copying the current Leadership, Directory, and Attendance views before resetting supported structures.',
      percent: 30,
      step: 1,
      totalSteps: 3,
    });
    archiveAndResetSheets(frontendId, Schemas.FRONTEND_TABS, frontendNames);
    ProgressService.report({
      title: 'Archiving core backend sheets',
      detail: 'Copying authoritative Leadership, Directory, and Attendance tables before resetting supported structures.',
      percent: 55,
      step: 2,
      totalSteps: 3,
    });
    archiveAndResetSheets(backendId, Schemas.BACKEND_TABS, backendNames);

    if (frontendId) {
      ensureFrontendTables(frontendId);
      FrontendFormattingService.applyAll(frontendId);
      ProtectionService.applyFrontendProtections(frontendId);
    }

    if (backendId) {
      applyAttendanceBackendFormatting();
    }
    ProgressService.report({
      title: 'Archive surfaces repaired',
      detail: 'Restored current-sheet tables, presentation, protections, and backend Attendance formatting.',
      percent: 90,
      step: 3,
      totalSteps: 3,
    });
  }

  export function restoreCoreSheetsFromArchive() {
    const frontendId = Config.getFrontendId();
    const backendId = Config.getBackendId();
    const frontendNames = ['Leadership', 'Directory', 'Attendance'];
    const backendNames = ['Leadership Backend', 'Directory Backend', 'Attendance Backend'];

    ProgressService.report({
      title: 'Restoring frontend core sheets',
      detail: 'Copying Leadership, Directory, and Attendance data back from their archive tabs.',
      percent: 30,
      step: 1,
      totalSteps: 3,
    });
    restoreFromArchiveSheets(frontendId, Schemas.FRONTEND_TABS, frontendNames);
    ProgressService.report({
      title: 'Restoring backend core sheets',
      detail: 'Copying authoritative Leadership, Directory, and Attendance data back from archive tabs.',
      percent: 55,
      step: 2,
      totalSteps: 3,
    });
    restoreFromArchiveSheets(backendId, Schemas.BACKEND_TABS, backendNames);

    if (frontendId) {
      ensureFrontendTables(frontendId);
      FrontendFormattingService.applyAll(frontendId);
      ProtectionService.applyFrontendProtections(frontendId);
    }

    if (backendId) {
      applyAttendanceBackendFormatting();
    }
    ProgressService.report({
      title: 'Restored sheets repaired',
      detail: 'Recreated expected tables, formatting, protections, and backend Attendance presentation.',
      percent: 90,
      step: 3,
      totalSteps: 3,
    });
  }

  export function runSetup(): Types.SetupSummary {
    Log.info('Starting setup (ensure-exists)');
    const spreadsheetResults: Types.EnsureSpreadsheetResult[] = [];
    const sheetResults: Types.EnsureSheetResult[] = [];
    const formResults: Types.EnsureFormResult[] = [];

    // Ensure spreadsheets.
    ProgressService.report({
      title: 'Checking SHAMROCK workbooks',
      detail: 'Locating or creating the main and admin workbooks from Script Properties.',
      hint: 'Setup is ensure-exists: rerunning it repairs missing resources without intentionally duplicating them.',
      percent: 10,
      step: 1,
      totalSteps: 10,
    });
    const frontend = ensureSpreadsheet('frontend', Config.RESOURCE_NAMES.FRONTEND_SPREADSHEET, Config.PROPERTY_KEYS.MAIN_SPREADSHEET_ID);
    const backend = ensureSpreadsheet('backend', Config.RESOURCE_NAMES.BACKEND_SPREADSHEET, Config.PROPERTY_KEYS.ADMIN_SPREADSHEET_ID);
    spreadsheetResults.push(frontend, backend);

    // Ensure excusals management spreadsheet.
    ProgressService.report({
      title: 'Checking the Excusals management workbook',
      detail: 'Ensuring the commander-facing workflow surface exists, is shared, and is protected.',
      percent: 18,
      step: 2,
      totalSteps: 10,
    });
    try {
      ExcusalsService.ensureManagementSpreadsheet();
      ExcusalsService.shareAndProtectManagementSpreadsheet();
    } catch (err) {
      Log.warn(`Failed to ensure excusals management spreadsheet: ${err}`);
    }

    // Ensure frontend sheets.
    ProgressService.report({
      title: 'Checking main workbook sheets',
      detail: `Ensuring ${Schemas.FRONTEND_TABS.length} frontend tab(s), stable headers, and expected names.`,
      percent: 27,
      step: 3,
      totalSteps: 10,
    });
    const frontendSheet = SpreadsheetApp.openById(frontend.id);
    Schemas.FRONTEND_TABS.forEach((tab) => {
      sheetResults.push(ensureSheet(frontendSheet, tab));
    });
    removeDefaultSheetIfPresent(frontendSheet, new Set(Schemas.FRONTEND_TABS.map((t) => t.name)));
    restoreMissingHeaders(frontendSheet, Schemas.FRONTEND_TABS);

    // Ensure backend sheets.
    ProgressService.report({
      title: 'Checking admin workbook sheets',
      detail: `Ensuring ${Schemas.BACKEND_TABS.length} authoritative and operational tab(s).`,
      percent: 36,
      step: 4,
      totalSteps: 10,
    });
    const backendSheet = SpreadsheetApp.openById(backend.id);
    Schemas.BACKEND_TABS.forEach((tab) => {
      sheetResults.push(ensureSheet(backendSheet, tab));
    });
    removeDefaultSheetIfPresent(backendSheet, new Set(Schemas.BACKEND_TABS.map((t) => t.name)));
    restoreMissingHeaders(backendSheet, Schemas.BACKEND_TABS);

    // Ensure forms.
    ProgressService.report({
      title: 'Checking SHAMROCK forms',
      detail: 'Ensuring Attendance, Excusals, and Directory forms and their supported settings.',
      percent: 45,
      step: 5,
      totalSteps: 10,
    });
    const attendanceForm = ensureForm('attendance', Config.RESOURCE_NAMES.ATTENDANCE_FORM, Config.PROPERTY_KEYS.ATTENDANCE_FORM_ID, backend.id);
    const excusalForm = ensureForm('excusals', Config.RESOURCE_NAMES.EXCUSALS_FORM, Config.PROPERTY_KEYS.EXCUSAL_REQUEST_FORM_ID, backend.id);
    const directoryForm = ensureForm('directory', Config.RESOURCE_NAMES.DIRECTORY_FORM, Config.PROPERTY_KEYS.CADET_DIRECTORY_FORM_ID, backend.id);
    formResults.push(attendanceForm, excusalForm, directoryForm);

    // Normalize response sheet names based on the form actually linked to each sheet.
    ProgressService.report({
      title: 'Verifying form response destinations',
      detail: 'Matching each form to the correct admin response sheet and checking response-sheet health.',
      percent: 54,
      step: 6,
      totalSteps: 10,
    });
    normalizeResponseSheetsForForms(backend.id, [
      { formId: attendanceForm.id, desiredSheetName: Config.RESOURCE_NAMES.ATTENDANCE_FORM_SHEET },
      { formId: excusalForm.id, desiredSheetName: Config.RESOURCE_NAMES.EXCUSALS_FORM_SHEET },
      { formId: directoryForm.id, desiredSheetName: Config.RESOURCE_NAMES.DIRECTORY_FORM_SHEET },
    ]);
    applyAttendanceBackendFormatting();

    // Refresh event choices for forms (attendance + excusals) after ensuring sheets/forms.
    ProgressService.report({
      title: 'Refreshing form choices and triggers',
      detail: 'Publishing current cadet/event options and ensuring submission handlers are installed once.',
      percent: 63,
      step: 7,
      totalSteps: 10,
    });
    refreshAttendanceFormEventChoices();
    refreshExcusalsFormEventChoices();

    // Ensure form submit triggers for receipts/processing.
    ensureFormTrigger('onAttendanceFormSubmit', attendanceForm.id);
    ensureFormTrigger('onExcusalsFormSubmit', excusalForm.id);
    ensureFormTrigger('onDirectoryFormSubmit', directoryForm.id);

    // Refresh Data Legend from canonical arrays and sync to frontend.
    ProgressService.report({
      title: 'Publishing option lists and core data',
      detail: 'Refreshing Data Legend choices, Directory, and derived Leadership views.',
      percent: 72,
      step: 8,
      totalSteps: 10,
    });
    refreshDataLegendAndFrontend();

    // Protect user-facing directory and sync it from backend.
    ProtectionService.applyFrontendProtections(frontend.id);
    DirectoryService.syncLeadershipBackendFromDirectory();
    DirectoryService.syncDirectoryFrontend();
    SyncService.syncByBackendSheetName('Leadership Backend');

    // Create structured tables on key frontend sheets via Sheets API.
    ProgressService.report({
      title: 'Repairing frontend tables and presentation',
      detail: 'Ensuring table objects, validation, standard formatting, and managed protections.',
      percent: 81,
      step: 9,
      totalSteps: 10,
    });
    ensureFrontendTables(frontend.id);

    // Apply frontend validations, plus visual formatting unless disabled.
    FrontendFormattingService.applyAll(frontend.id);

    // Build attendance matrix initially.
    ProgressService.report({
      title: 'Finishing attendance, ordering, and automations',
      detail: 'Rebuilding derived attendance, ordering tabs, and checking spreadsheet and maintenance triggers.',
      percent: 90,
      step: 10,
      totalSteps: 10,
    });
    rebuildAttendanceMatrix();

    // Order sheets for predictable UX
    reorderFrontendSheets();
    reorderBackendSheets();

    // Install spreadsheet triggers. Frontend onOpen is intentionally a no-op;
    // backend onOpen adds the admin menu for anyone with access to that sheet.
    ensureSpreadsheetTrigger('onFrontendOpen', frontend.id, 'open');
    ensureSpreadsheetTrigger('onFrontendEdit', frontend.id, 'edit');
    ensureSpreadsheetTrigger('onBackendOpen', backend.id, 'open');
    ensureSpreadsheetTrigger('onBackendEdit', backend.id, 'edit');

    // Time-based trigger: reconcile frontend Directory edits every 10 minutes (handles edits by unauthorized users).
    ensurePeriodicTrigger('reconcilePendingDirectoryEdits', 10);
    ensureDailyTrigger('cleanupExpiredTransitionArchivesV2');

    Log.info(`Setup finished: spreadsheets=${spreadsheetResults.length}, sheets=${sheetResults.length}, forms=${formResults.length}`);

    return {
      spreadsheets: spreadsheetResults,
      sheets: sheetResults,
      forms: formResults,
    };
  }
}
