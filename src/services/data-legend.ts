// Data Legend maintenance: populate backend legend from canonical Arrays values and sync to frontend.

namespace DataLegendService {
  interface LegendColumn {
    header: string; // sheet header key
    rangeName: string; // named range to set
    values: string[];
  }

  const legendSchema = Schemas.BACKEND_TABS.find((t) => t.name === 'Data Legend');
  const LEGEND_HEADERS = legendSchema?.machineHeaders || [
    'as_year_options',
    'rank_options',
    'flight_options',
    'squadron_options',
    'university_options',
    'dorm_options',
    'home_state_options',
    'cip_broad_area_options',
    'afsc_options',
    'flight_path_status_options',
    'attendance_code_options',
  ];
  const LEGEND_DISPLAY_HEADERS = legendSchema?.displayHeaders || [
    'AS Year Options',
    'Rank Options',
    'Flight Options',
    'Squadron Options',
    'University Options',
    'Dorm Options',
    'Home State Options',
    'CIP Broad Area Options',
    'AFSC Options',
    'Flight Path Status Options',
    'Attendance Code Options',
  ];

  function legendColumns(): LegendColumn[] {
    const A: any = (globalThis as any).Arrays;
    if (!A) {
      Log.warn('Arrays namespace not available; Data Legend not populated.');
      return [];
    }
    const valueMap: Record<string, string[]> = {
      as_year_options: A.AS_YEARS || [],
      rank_options: A.CADET_RANKS || [],
      flight_options: A.FLIGHTS || [],
      squadron_options: A.SQUADRONS || [],
      university_options: A.UNIVERSITIES || [],
      dorm_options: A.DORMS || [],
      home_state_options: A.HOME_STATES || [],
      cip_broad_area_options: A.CIP_BROAD_AREAS || [],
      afsc_options: A.AFSC_OPTIONS || [],
      flight_path_status_options: A.FLIGHT_PATH_STATUSES || [],
      attendance_code_options: A.ATTENDANCE_CODES || [],
    };

    const rangeMap: Record<string, string> = {
      as_year_options: 'AS_YEARS',
      rank_options: 'CADET_RANKS',
      flight_options: 'FLIGHTS',
      squadron_options: 'SQUADRONS',
      university_options: 'UNIVERSITIES',
      dorm_options: 'DORMS',
      home_state_options: 'HOME_STATES',
      cip_broad_area_options: 'CIP_BROAD_AREAS',
      afsc_options: 'AFSC_OPTIONS',
      flight_path_status_options: 'FLIGHT_PATH_STATUSES',
      attendance_code_options: 'ATTENDANCE_CODES',
    };

    return LEGEND_HEADERS.map((header) => ({
      header,
      rangeName: rangeMap[header] || header.toUpperCase(),
      values: valueMap[header] || [],
    }));
  }

  function getBackendLegendSheet(): GoogleAppsScript.Spreadsheet.Sheet {
    return Config.getBackendSheet('Data Legend');
  }

  function ensureLegendHeaders(sheet: GoogleAppsScript.Spreadsheet.Sheet) {
    const width = LEGEND_HEADERS.length;
    sheet.getRange(1, 1, 1, width).setValues([LEGEND_HEADERS]);
    sheet.getRange(2, 1, 1, width).setValues([LEGEND_DISPLAY_HEADERS]);
    // Trim extra columns if present
    const maxCols = sheet.getMaxColumns();
    if (maxCols > width) {
      sheet.deleteColumns(width + 1, maxCols - width);
    }
  }

  export function refreshLegendFromArrays() {
    const sheet = getBackendLegendSheet();
    const cols = legendColumns();
    if (!cols.length) return;
    ensureLegendHeaders(sheet);
    const maxLen = cols.reduce((m, c) => Math.max(m, c.values.length), 0);
    // Clear existing data rows
    const lastRow = sheet.getLastRow();
    if (lastRow > 2) {
      sheet.getRange(3, 1, lastRow - 2, sheet.getMaxColumns()).clearContent();
    }
    if (maxLen === 0) return;
    const matrix: string[][] = [];
    for (let i = 0; i < maxLen; i++) {
      const row: string[] = [];
      cols.forEach((c) => {
        row.push(c.values[i] || '');
      });
      matrix.push(row);
    }
    sheet.getRange(3, 1, matrix.length, cols.length).setValues(matrix);
  }
}
