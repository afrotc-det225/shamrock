// Directory sync and form upsert helpers.

namespace DirectoryService {
  const MATRIX_DERIVED_FIELDS = new Set(['first_name', 'last_name', 'as_year', 'flight', 'squadron', 'flight_path_status']);
  const FORM_DERIVED_FIELDS = new Set(['first_name', 'last_name', 'as_year', 'flight', 'university', 'flight_path_status']);

  interface DirectoryRecord {
    last_name: string;
    first_name: string;
    as_year: string;
    flight: string;
    squadron: string;
    rank: string;
    role: string;
    university: string;
    email: string;
    phone: string;
    dorm: string;
    cip_broad_area: string;
    cip_code: string;
    desired_assigned_afsc: string;
    home_town: string;
    home_state: string;
    class_year: string;
    dob: string;
    flight_path_status: string;
    photo_link: string;
  }

  function getBackendFrontendSheets() {
    const backendId = Config.getBackendId();
    const frontendId = Config.getFrontendId();
    const backendSheet = backendId ? SheetUtils.getSheet(backendId, 'Directory Backend') : null;
    const frontendSheet = frontendId ? SheetUtils.getSheet(frontendId, 'Directory') : null;
    return { backendSheet, frontendSheet };
  }

  function normalizeDirectoryFieldName(field: string): string {
    return String(field || '').trim().toLowerCase();
  }

  function normalizeFlightPathStatus(status: any): string {
    return String(status || '').trim().toLowerCase();
  }

  export function isOperationallyActiveCadet(row: any): boolean {
    const inactiveStatuses = new Set(
      (((globalThis as any).Arrays?.NON_OPERATIONAL_FLIGHT_PATH_STATUSES as string[] | undefined) || ['Inactive', 'Commissioned', 'Dropped'])
        .map((status) => normalizeFlightPathStatus(status)),
    );
    return !inactiveStatuses.has(normalizeFlightPathStatus(row?.['flight_path_status']));
  }

  export function shouldRebuildAttendanceMatrixForField(field: string): boolean {
    return MATRIX_DERIVED_FIELDS.has(normalizeDirectoryFieldName(field));
  }

  export function shouldRebuildAttendanceFormForField(field: string): boolean {
    return FORM_DERIVED_FIELDS.has(normalizeDirectoryFieldName(field));
  }

  function normalizePhone(raw: string): string {
    const digits = String(raw || '').replace(/^'+/, '').replace(/\D+/g, '');
    if (!digits) return '';
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    return `+${digits}`;
  }

  function formatPhoneDisplay(phone: string): string {
    const digits = phone.replace(/\D+/g, '');
    if (digits.length === 11 && digits.startsWith('1')) {
      const area = digits.slice(1, 4);
      const prefix = digits.slice(4, 7);
      const line = digits.slice(7, 11);
      return `+1 (${area}) ${prefix}-${line}`;
    }
    return phone;
  }

  function sortDirectoryRows(rows: any[]): any[] {
    const asPriority = (() => {
      const arr = (globalThis as any).Arrays?.AS_YEARS as string[] | undefined;
      const base = arr && arr.length ? arr.slice().reverse() : ['AS900', 'AS800', 'AS700', 'AS500', 'AS400', 'AS300', 'AS250', 'AS200', 'AS150', 'AS100'];
      const map = new Map<string, number>();
      base.forEach((v, idx) => map.set(String(v), base.length - idx));
      return map;
    })();

    const rank = (asYear: string): number => asPriority.get(String(asYear || '').trim()) || 0;

    return rows.slice().sort((a, b) => {
      const aRank = rank(a.as_year);
      const bRank = rank(b.as_year);
      if (aRank !== bRank) return aRank > bRank ? -1 : 1; // higher AS rank first (Z->A)

      const lastCmp = String(a.last_name || '').localeCompare(String(b.last_name || ''), undefined, { sensitivity: 'base' });
      if (lastCmp !== 0) return lastCmp;
      return String(a.first_name || '').localeCompare(String(b.first_name || ''), undefined, { sensitivity: 'base' });
    });
  }

  function sanitizeCipCode(raw: string): string {
    const cleaned = String(raw || '').split(/[,;]/)[0].trim();
    const match = cleaned.match(/\d{2}\.\d{4}/);
    return match ? match[0] : cleaned;
  }

  export function syncDirectoryFrontend(): void {
    const { backendSheet, frontendSheet } = getBackendFrontendSheets();
    if (!backendSheet || !frontendSheet) return;
    SheetUtils.ensureSchemaColumns(backendSheet);
    const backend = SheetUtils.readTable(backendSheet);
    SheetUtils.ensureSchemaColumns(frontendSheet);
    const mapped = backend.rows.filter((row) => isOperationallyActiveCadet(row)).map((row) => ({
      last_name: row['last_name'] || '',
      first_name: row['first_name'] || '',
      as_year: row['as_year'] || '',
      flight: row['flight'] || '',
      squadron: row['squadron'] || '',
      rank: row['rank'] || '',
      role: row['role'] || '',
      university: row['university'] || '',
      email: row['email'] || '',
      phone: formatPhoneDisplay(normalizePhone(String(row['phone'] || ''))),
      dorm: row['dorm'] || '',
      cip_broad_area: row['cip_broad_area'] || '',
      cip_code: row['cip_code'] || '',
      desired_assigned_afsc: row['desired_assigned_afsc'] || '',
      home_town: row['home_town'] || '',
      home_state: row['home_state'] || '',
      class_year: row['class_year'] || '',
      dob: row['dob'] || '',
      flight_path_status: row['flight_path_status'] || '',
      photo_link: row['photo_link'] || '',
    }));

    const sorted = sortDirectoryRows(mapped);
    SheetUtils.writeTable(frontendSheet, sorted, { clearDataValidationsBeforeWrite: true, trimBlankRows: true });
  }

  function upsertBackendRecord(record: DirectoryRecord) {
    const { backendSheet } = getBackendFrontendSheets();
    if (!backendSheet) return;
    SheetUtils.ensureSchemaColumns(backendSheet);
    const table = SheetUtils.readTable(backendSheet);
    const emailKey = String(record.email || '').toLowerCase();
    let updated = false;
    const nextRows = table.rows.map((row) => {
      const rowEmail = String(row['email'] || '').toLowerCase();
      if (emailKey && rowEmail === emailKey) {
        updated = true;
        return record;
      }
      return row;
    });
    if (!updated) {
      nextRows.push(record);
    }
    SheetUtils.writeTable(backendSheet, nextRows);
  }

  function getNamedValues(e: GoogleAppsScript.Events.FormsOnFormSubmit): Record<string, string[]> {
    return ((e as any).namedValues as Record<string, string[]>) || {};
  }

  function getFirst(namedValues: Record<string, string[]>, key: string): string {
    const raw = namedValues[key];
    if (!raw) return '';
    const arr = Array.isArray(raw) ? raw : [raw];
    return String(arr[0] || '').trim();
  }

  export function handleDirectoryFormSubmission(e: GoogleAppsScript.Events.FormsOnFormSubmit) {
    const nv = getNamedValues(e);

    // Build a case-insensitive map of item titles -> response (string)
    const itemMap = (() => {
      const m = new Map<string, string>();
      try {
        e.response.getItemResponses().forEach((ir) => {
          const title = String(ir.getItem().getTitle?.() || '').trim().toLowerCase();
          if (!title) return;
          const resp = ir.getResponse();
          let value = '';
          if (Array.isArray(resp)) {
            value = resp.map((r) => String(r || '').trim()).filter(Boolean).join(', ');
          } else {
            value = String(resp || '').trim();
          }
          if (!value) return;
          m.set(title, value);
        });
      } catch (err) {
        Log.warn(`Directory form: unable to read item responses: ${err}`);
      }
      return m;
    })();

    const pick = (keys: string[], fallbackKey?: string): string => {
      for (const k of keys) {
        const found = itemMap.get(k.toLowerCase());
        if (found) return found;
      }
      if (fallbackKey) return getFirst(nv, fallbackKey);
      for (const k of keys) {
        const val = getFirst(nv, k);
        if (val) return val;
      }
      return '';
    };

    const respondentEmail = String(e.response.getRespondentEmail?.() || '').trim();
    const email =
      respondentEmail ||
      pick(['email', 'email address', 'email address (college)'], 'Email') ||
      getFirst(nv, 'Email Address');

    const record: DirectoryRecord = {
      last_name: pick(['last name', 'last']),
      first_name: pick(['first name', 'first']),
      as_year: pick(['as year', 'as-year', 'year']),
      flight: pick(['flight']),
      squadron: pick(['squadron']),
      rank: pick(['rank', 'cadet rank']),
      role: pick(['role', 'leadership role']),
      university: pick(['university', 'school']),
      email,
      phone: normalizePhone(pick(['phone (+5 (555) 555-5555)', 'phone', 'phone number'])),
      dorm: pick(['dorm']),
      cip_broad_area: pick(['cip broad area', 'cip broad']),
      cip_code: sanitizeCipCode(pick(['cip code (xx.xxxx)', 'cip code'])),
      desired_assigned_afsc: pick(['desired/assigned afsc', 'afsc']),
      home_town: pick(['home town', 'hometown']),
      home_state: pick(['home state', 'state']),
      class_year: pick(['class year (yyyy)', 'class year']),
      dob: pick(['dob (mm/dd/yyyy)', 'dob', 'date of birth']),
      flight_path_status: pick(['flight path status', 'flight path']),
      photo_link: pick(['photo link (url)', 'photo link', 'photo url']),
    };

    upsertBackendRecord(record);
    SetupService.refreshDirectoryArtifacts({ rebuildAttendanceMatrix: true, rebuildAttendanceForm: true });
  }

  function normalizeIdentity(row: any): string {
    const email = String(row?.['email'] || '').trim().toLowerCase();
    if (email) return `email:${email}`;
    const last = String(row?.['last_name'] || '').trim().toLowerCase();
    const first = String(row?.['first_name'] || '').trim().toLowerCase();
    return last || first ? `name:${last},${first}` : '';
  }

  function isCadetDirectoryRow(row: any): boolean {
    const email = String(row?.['email'] || '').toLowerCase();
    return email.includes('@') || Boolean(row?.['as_year']);
  }

  function normalizeRoleForMatch(role: string): string {
    return role
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isLeadershipDirectoryRole(roleRaw: string): boolean {
    const role = normalizeRoleForMatch(roleRaw);
    if (!role) return false;

    const isDeputy = role.includes('deputy');
    if (role.includes('flight commander')) return !isDeputy;
    if (role.includes('squadron commander')) return !isDeputy;
    if (role.includes('wing commander')) return !isDeputy || role.includes('deputy wing commander');
    if (role.includes('operations group commander')) return true;
    if (role.includes('operations group deputy commander')) return true;
    if (role.includes('operations group deputy')) return true;
    if (role.includes('senior gmc advisor')) return true;
    if (role.includes('deputy gmc advisor')) return true;

    return false;
  }

  function leadershipRowFromDirectory(row: any): Record<string, any> | null {
    const role = String(row?.['role'] || '').trim();
    if (!isLeadershipDirectoryRole(role)) return null;
    return {
      last_name: row['last_name'] || '',
      first_name: row['first_name'] || '',
      rank: row['rank'] || '',
      role,
      flight: row['flight'] || '',
      squadron: row['squadron'] || '',
      reports_to: '',
      email: row['email'] || '',
      cell_phone: normalizePhone(String(row['phone'] || '')),
      office_phone: '',
      office_location: '',
    };
  }

  export function syncLeadershipBackendFromDirectory(): void {
    const backendId = Config.getBackendId();
    if (!backendId) return;
    const directorySheet = SheetUtils.getSheet(backendId, 'Directory Backend');
    const leadershipSheet = SheetUtils.getSheet(backendId, 'Leadership Backend');
    if (!directorySheet || !leadershipSheet) return;

    SheetUtils.ensureSchemaColumns(directorySheet);
    SheetUtils.ensureSchemaColumns(leadershipSheet);
    const directoryRows = SheetUtils.readTable(directorySheet).rows;
    const currentLeadership = SheetUtils.readTable(leadershipSheet).rows;

    const activeDirectoryIdentities = new Set<string>();
    const derivedRows: Record<string, any>[] = [];
    directoryRows.filter((row) => isOperationallyActiveCadet(row)).forEach((row) => {
      const identity = normalizeIdentity(row);
      if (identity) activeDirectoryIdentities.add(identity);
      const leadership = leadershipRowFromDirectory(row);
      if (leadership) derivedRows.push(leadership);
    });

    const preservedRows = currentLeadership.filter((row) => {
      const identity = normalizeIdentity(row);
      if (!identity) return true;
      if (!activeDirectoryIdentities.has(identity)) return true;
      return !isCadetDirectoryRow(row);
    });

    const nextRows = preservedRows.concat(
      derivedRows.sort((a, b) => {
        const roleCmp = String(a.role || '').localeCompare(String(b.role || ''), undefined, { sensitivity: 'base' });
        if (roleCmp !== 0) return roleCmp;
        const lastCmp = String(a.last_name || '').localeCompare(String(b.last_name || ''), undefined, { sensitivity: 'base' });
        if (lastCmp !== 0) return lastCmp;
        return String(a.first_name || '').localeCompare(String(b.first_name || ''), undefined, { sensitivity: 'base' });
      }),
    );

    SheetUtils.writeTable(leadershipSheet, nextRows);
  }

  /**
   * Replays the most recent Directory form response through the handler (useful for debugging ingestion).
   * Reads the cadet directory form and constructs a synthetic FormsOnFormSubmit event.
   */
  export function replayLatestDirectoryFormResponse(): boolean {
    const formId = Config.getScriptProperty(Config.PROPERTY_KEYS.CADET_DIRECTORY_FORM_ID);
    if (!formId) {
      Log.warn(`${Config.PROPERTY_KEYS.CADET_DIRECTORY_FORM_ID} missing; cannot replay Directory form response.`);
      return false;
    }

    try {
      const form = FormApp.openById(formId);
      const responses = form.getResponses();
      if (!responses.length) {
        Log.warn('Cannot replay Directory form response: no responses found.');
        return false;
      }
      const resp = responses[responses.length - 1];

      // Build namedValues from item titles.
      const namedValues: Record<string, string[]> = {};
      resp.getItemResponses().forEach((ir) => {
        const title = String(ir.getItem().getTitle?.() || '').trim();
        const raw = ir.getResponse();
        if (!title) return;
        if (Array.isArray(raw)) namedValues[title] = raw.map((r) => String(r || '').trim());
        else namedValues[title] = [String(raw || '').trim()];
      });

      const syntheticEvent = {
        response: resp,
        namedValues,
      } as unknown as GoogleAppsScript.Events.FormsOnFormSubmit;

      handleDirectoryFormSubmission(syntheticEvent);
      return true;
    } catch (err) {
      Log.warn(`Unable to replay Directory form response: ${err}`);
      return false;
    }
  }

  export function protectFrontendDirectory(frontendId: string) {
    const sheet = Config.getFrontendSheet('Directory');

    // Clear any sheet-level protections so cadet edits are not blocked.
    (sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET) || []).forEach((p: GoogleAppsScript.Spreadsheet.Protection) => p.remove());

    // Remove legacy header protections to avoid stacking.
    const headerProtections = (sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE) || []).filter((p: GoogleAppsScript.Spreadsheet.Protection) => {
      const r = p.getRange();
      return r.getRow() === 1 && r.getNumRows() <= 2;
    });
    headerProtections.forEach((p: GoogleAppsScript.Spreadsheet.Protection) => p.remove());

    // Add a warning-only protection on the header rows (machine + display) to discourage edits without blocking the sheet.
    try {
      const headerRange = sheet.getRange(1, 1, 2, sheet.getMaxColumns());
      const protection = headerRange.protect();
      protection.setDescription('Directory headers (auto)');
      protection.setWarningOnly(true);
    } catch (err) {
      Log.warn(`Unable to apply Directory header protection: ${err}`);
    }
  }
}
