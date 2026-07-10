// V2 semester and academic-year transition workflow.

namespace TransitionService {
  type TransitionKind = 'semester' | 'academic_year';

  interface RoleUpdate {
    role: string;
    rank: string;
  }

  interface TransitionDraft {
    kind: TransitionKind;
    term: string;
    firstTrainingWeek: number;
    trainingWeeks: number;
    firstWeekSunday: string;
    mandoWeekday: number;
    mandoStartTime: string;
    mandoMinutes: number;
    llabWeekday: number;
    llabStartTime: string;
    llabMinutes: number;
    thirdHourWeekday: number;
    thirdHourStartTime: string;
    thirdHourMinutes: number;
    removedCadets: string[];
    asYearOverrides: Record<string, string>;
    roleUpdates: Record<string, RoleUpdate>;
    removedLeadership: string[];
    createdAt: string;
  }

  interface ArchiveRecord {
    spreadsheetId: string;
    sheetNames: string[];
    expiresAt: string;
  }

  type TransitionPhase =
    | 'archive'
    | 'directory'
    | 'logs'
    | 'events'
    | 'leadership'
    | 'responses'
    | 'directory_artifacts'
    | 'events_artifacts'
    | 'directory_form'
    | 'attendance_form'
    | 'excusals_form'
    | 'triggers'
    | 'reorder'
    | 'audit';

  interface TransitionState {
    id: string;
    draft: TransitionDraft;
    archives: ArchiveRecord[];
    completedPhases: TransitionPhase[];
    startedAt: string;
    updatedAt: string;
  }

  const WEEKDAY_INDEX: Record<string, number> = {
    sunday: 0,
    sun: 0,
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    tues: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    thurs: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6,
  };
  const TRANSITION_PHASES: TransitionPhase[] = [
    'archive',
    'directory',
    'logs',
    'events',
    'leadership',
    'responses',
    'directory_artifacts',
    'events_artifacts',
    'directory_form',
    'attendance_form',
    'excusals_form',
    'triggers',
    'reorder',
    'audit',
  ];
  const CONTINUATION_HANDLER = 'continueTransitionV2';
  const TRANSITION_CONTINUATION_BUDGET_MS = 4 * 60 * 1000;

  function ui(): GoogleAppsScript.Base.Ui {
    return SpreadsheetApp.getUi();
  }

  function alert(message: string) {
    try {
      ui().alert(message);
    } catch {
      Log.info(message);
    }
  }

  function saveDraft(draft: TransitionDraft) {
    Config.setScriptProperty(Config.PROPERTY_KEYS.V2_TRANSITION_DRAFT, JSON.stringify(draft));
  }

  function loadDraft(): TransitionDraft | null {
    const raw = Config.getScriptProperty(Config.PROPERTY_KEYS.V2_TRANSITION_DRAFT);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TransitionDraft;
    } catch (err) {
      Log.warn(`Unable to parse saved transition draft; discarding. Error: ${err}`);
      Config.deleteScriptProperty(Config.PROPERTY_KEYS.V2_TRANSITION_DRAFT);
      return null;
    }
  }

  function saveState(state: TransitionState) {
    state.updatedAt = new Date().toISOString();
    Config.setScriptProperty(Config.PROPERTY_KEYS.V2_TRANSITION_STATE, JSON.stringify(state));
  }

  function loadState(): TransitionState | null {
    const raw = Config.getScriptProperty(Config.PROPERTY_KEYS.V2_TRANSITION_STATE);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TransitionState;
    } catch (err) {
      Log.warn(`Unable to parse saved transition execution state; discarding. Error: ${err}`);
      Config.deleteScriptProperty(Config.PROPERTY_KEYS.V2_TRANSITION_STATE);
      return null;
    }
  }

  function createState(draft: TransitionDraft): TransitionState {
    return {
      id: Utilities.getUuid(),
      draft,
      archives: [],
      completedPhases: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function phaseComplete(state: TransitionState, phase: TransitionPhase): boolean {
    return state.completedPhases.includes(phase);
  }

  function completePhase(state: TransitionState, phase: TransitionPhase) {
    if (!phaseComplete(state, phase)) state.completedPhases.push(phase);
    saveState(state);
  }

  function clearContinuationTriggers() {
    ScriptApp.getProjectTriggers()
      .filter((trigger) => trigger.getHandlerFunction() === CONTINUATION_HANDLER)
      .forEach((trigger) => {
        try {
          ScriptApp.deleteTrigger(trigger);
        } catch (err) {
          Log.warn(`Unable to delete transition continuation trigger: ${err}`);
        }
      });
  }

  function scheduleContinuation() {
    clearContinuationTriggers();
    ScriptApp.newTrigger(CONTINUATION_HANDLER).timeBased().after(60 * 1000).create();
    Log.info('Scheduled v2 transition continuation trigger.');
  }

  function promptValue(title: string, message: string, fallback: string): string {
    const response = ui().prompt(title, `${message}\n\nDefault: ${fallback}`, ui().ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui().Button.OK) {
      throw new Error(`Transition wizard cancelled at "${title}". Draft was saved; run the wizard again to resume.`);
    }
    const value = String(response.getResponseText() || '').trim();
    return value || fallback;
  }

  function parsePositiveInt(raw: string, fallback: number): number {
    const parsed = Number(String(raw || '').trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  function parseWeekday(raw: string, fallback: number): number {
    const key = String(raw || '').trim().toLowerCase();
    return WEEKDAY_INDEX[key] ?? fallback;
  }

  function parseList(raw: string): string[] {
    return String(raw || '')
      .split(/\r?\n|;/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function parseMap(raw: string): Record<string, string> {
    const result: Record<string, string> = {};
    parseList(raw).forEach((entry) => {
      const idx = entry.indexOf('=');
      if (idx < 1) return;
      const key = entry.slice(0, idx).trim().toLowerCase();
      const value = entry.slice(idx + 1).trim();
      if (key && value) result[key] = value;
    });
    return result;
  }

  function parseRoleUpdates(raw: string): Record<string, RoleUpdate> {
    const result: Record<string, RoleUpdate> = {};
    Object.entries(parseMap(raw)).forEach(([key, value]) => {
      const [roleRaw, rankRaw] = value.split('|').map((s) => String(s || '').trim());
      result[key] = { role: roleRaw || '', rank: rankRaw || '' };
    });
    return result;
  }

  function defaultTerm(kind: TransitionKind): string {
    const now = new Date();
    const year = now.getFullYear();
    return kind === 'academic_year' ? `${year}-Fall` : `${year}-Spring`;
  }

  function buildDraft(kind: TransitionKind): TransitionDraft {
    const existing = loadDraft();
    if (existing && existing.kind === kind) {
      const resume = ui().alert(
        'Resume saved transition draft?',
        `A saved ${kind === 'academic_year' ? 'academic year' : 'semester'} draft exists for ${existing.term}. Resume it?`,
        ui().ButtonSet.YES_NO,
      );
      if (resume === ui().Button.YES) return existing;
      Config.deleteScriptProperty(Config.PROPERTY_KEYS.V2_TRANSITION_DRAFT);
    }

    const draft: TransitionDraft = {
      kind,
      term: promptValue('New term', 'Enter the new term label (example: 2026-Fall or 2027-Spring).', defaultTerm(kind)),
      firstTrainingWeek: kind === 'academic_year' ? 1 : 17,
      trainingWeeks: 16,
      firstWeekSunday: '',
      mandoWeekday: 4,
      mandoStartTime: '06:30',
      mandoMinutes: 60,
      llabWeekday: 2,
      llabStartTime: '15:30',
      llabMinutes: 120,
      thirdHourWeekday: 4,
      thirdHourStartTime: '15:30',
      thirdHourMinutes: 60,
      removedCadets: [],
      asYearOverrides: {},
      roleUpdates: {},
      removedLeadership: [],
      createdAt: new Date().toISOString(),
    };
    saveDraft(draft);

    draft.firstTrainingWeek = parsePositiveInt(promptValue('First training week', 'Fall usually starts at 1; spring usually starts at 17.', String(draft.firstTrainingWeek)), draft.firstTrainingWeek);
    draft.trainingWeeks = parsePositiveInt(promptValue('Training week count', 'Enter the number of training weeks to generate.', String(draft.trainingWeeks)), draft.trainingWeeks);
    draft.firstWeekSunday = promptValue('First week Sunday', 'Enter the Sunday date that starts the first generated training week (YYYY-MM-DD).', defaultFirstSunday());
    saveDraft(draft);

    draft.mandoWeekday = parseWeekday(promptValue('Mando PT weekday', 'Enter the weekday for Mando PT.', 'Thursday'), draft.mandoWeekday);
    draft.mandoStartTime = promptValue('Mando PT start time', 'Enter start time using 24-hour HH:MM.', draft.mandoStartTime);
    draft.mandoMinutes = parsePositiveInt(promptValue('Mando PT duration', 'Enter duration in minutes.', String(draft.mandoMinutes)), draft.mandoMinutes);
    saveDraft(draft);

    draft.llabWeekday = parseWeekday(promptValue('LLAB weekday', 'Enter the weekday for LLAB.', 'Tuesday'), draft.llabWeekday);
    draft.llabStartTime = promptValue('LLAB start time', 'Enter start time using 24-hour HH:MM.', draft.llabStartTime);
    draft.llabMinutes = parsePositiveInt(promptValue('LLAB duration', 'Enter duration in minutes.', String(draft.llabMinutes)), draft.llabMinutes);
    saveDraft(draft);

    draft.thirdHourWeekday = parseWeekday(promptValue('POC Third Hour weekday', 'Enter the weekday for POC Third Hour.', 'Thursday'), draft.thirdHourWeekday);
    draft.thirdHourStartTime = promptValue('POC Third Hour start time', 'Enter start time using 24-hour HH:MM.', draft.thirdHourStartTime);
    draft.thirdHourMinutes = parsePositiveInt(promptValue('POC Third Hour duration', 'Enter duration in minutes.', String(draft.thirdHourMinutes)), draft.thirdHourMinutes);
    saveDraft(draft);

    draft.removedCadets = parseList(promptValue('Dropped cadets', 'Optional. Enter emails or "Last, First" identifiers for cadets to remove, separated by semicolons or new lines.', ''));
    if (kind === 'academic_year') {
      draft.asYearOverrides = parseMap(promptValue('Non-standard AS years', 'Optional. Enter identifier=AS year overrides, one per line or separated by semicolons. Example: cadet@example.edu=AS500', ''));
    }
    draft.roleUpdates = parseRoleUpdates(promptValue('Leadership role updates', 'Optional. Enter identifier=Role|Rank, one per line or separated by semicolons. Example: cadet@example.edu=Alpha Flight Commander|C/1st Lt', ''));
    draft.removedLeadership = parseList(promptValue('Removed cadre/manual leadership', 'Optional. Enter emails or "Last, First" identifiers for cadre/manual Leadership rows to remove.', ''));
    saveDraft(draft);
    return draft;
  }

  function defaultFirstSunday(): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  function parseDateOnly(raw: string): Date {
    const parts = String(raw || '').trim().split('-').map((p) => Number(p));
    if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) throw new Error(`Invalid date: ${raw}`);
    return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
  }

  function dateForWeekday(weekStart: Date, weekday: number, time: string, durationMinutes = 0): Date {
    const [hourRaw, minuteRaw] = String(time || '00:00').split(':');
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + weekday);
    date.setHours(Number(hourRaw) || 0, Number(minuteRaw) || 0, 0, 0);
    if (durationMinutes) date.setMinutes(date.getMinutes() + durationMinutes);
    return date;
  }

  function isoLocal(date: Date): string {
    return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX");
  }

  function previousTermLabelForArchive(draft: TransitionDraft): string {
    const match = String(draft.term || '').trim().match(/^(\d{4})[-\s_]+(Fall|Spring)$/i);
    if (!match) return 'Previous Term';
    const year = Number(match[1]);
    const season = match[2].toLowerCase();
    if (season === 'fall') return `Spring ${year}`;
    return `Fall ${year - 1}`;
  }

  function archiveSheet(
    spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet,
    sheetName: string,
    archiveName: string,
    hide: boolean,
  ): string {
    const source = spreadsheet.getSheetByName(sheetName);
    if (!source) return '';
    let finalName = archiveName;
    let counter = 2;
    while (spreadsheet.getSheetByName(finalName)) {
      finalName = `${archiveName} ${counter}`;
      counter += 1;
    }
    const archived = source.copyTo(spreadsheet).setName(finalName);
    SheetUtils.renameTablesOnSheet(spreadsheet.getId(), archived, finalName);
    const range = archived.getDataRange();
    range.copyTo(range, { contentsOnly: true });
    archived.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach((p) => p.remove());
    archived.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach((p) => p.remove());
    try {
      const protection = archived.protect().setDescription(`${finalName} archive`);
      protection.setWarningOnly(false);
      protection.removeEditors(protection.getEditors());
      if (protection.canDomainEdit()) protection.setDomainEdit(false);
    } catch (err) {
      Log.warn(`Unable to fully protect archive ${finalName}: ${err}`);
    }
    if (hide) archived.hideSheet();
    return finalName;
  }

  function archiveForTransition(draft: TransitionDraft): ArchiveRecord[] {
    const records: ArchiveRecord[] = [];
    const previousLabel = previousTermLabelForArchive(draft);
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
    const frontendId = Config.getFrontendId();
    const backendId = Config.getBackendId();

    if (frontendId) {
      const ss = SpreadsheetApp.openById(frontendId);
      ['Leadership', 'Directory', 'Attendance'].forEach((name) => {
        archiveSheet(ss, name, `${previousLabel} ${name}`, true);
      });
    }

    if (backendId) {
      const ss = SpreadsheetApp.openById(backendId);
      const sheetNames = ['Leadership Backend', 'Directory Backend', 'Events Backend', 'Attendance Backend', 'Excusals Backend'];
      const archivedNames = sheetNames
        .map((name) => archiveSheet(ss, name, `Rollback ${stamp} ${name}`, true))
        .filter(Boolean);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      records.push({ spreadsheetId: backendId, sheetNames: archivedNames, expiresAt });
    }

    registerArchives(records);
    return records;
  }

  function registerArchives(records: ArchiveRecord[]) {
    if (!records.length) return;
    const existingRaw = Config.getScriptProperty(Config.PROPERTY_KEYS.V2_BACKEND_ARCHIVES);
    let existing: ArchiveRecord[] = [];
    if (existingRaw) {
      try {
        existing = JSON.parse(existingRaw) as ArchiveRecord[];
      } catch {
        existing = [];
      }
    }
    Config.setScriptProperty(Config.PROPERTY_KEYS.V2_BACKEND_ARCHIVES, JSON.stringify(existing.concat(records)));
  }

  function archiveTimestampMs(record: ArchiveRecord): number {
    const joined = record.sheetNames.join(' ');
    const match = joined.match(/Rollback\s+(\d{8})-(\d{6})/);
    if (!match) return 0;
    const [, datePart, timePart] = match;
    return new Date(
      Number(datePart.slice(0, 4)),
      Number(datePart.slice(4, 6)) - 1,
      Number(datePart.slice(6, 8)),
      Number(timePart.slice(0, 2)),
      Number(timePart.slice(2, 4)),
      Number(timePart.slice(4, 6)),
    ).getTime();
  }

  function latestRegisteredBackendArchive(draft: TransitionDraft): ArchiveRecord[] {
    const raw = Config.getScriptProperty(Config.PROPERTY_KEYS.V2_BACKEND_ARCHIVES);
    if (!raw) return [];
    try {
      const records = JSON.parse(raw) as ArchiveRecord[];
      const backendId = Config.getBackendId();
      const draftCreatedAt = new Date(draft.createdAt).getTime();
      const latest = records
        .filter((record) => (
          record.spreadsheetId === backendId
          && record.sheetNames.some((name) => name.endsWith('Directory Backend'))
          && archiveTimestampMs(record) >= draftCreatedAt - 5 * 60 * 1000
        ))
        .pop();
      return latest ? [latest] : [];
    } catch {
      return [];
    }
  }

  function backendArchiveSheet(state: TransitionState, suffix: string): GoogleAppsScript.Spreadsheet.Sheet | null {
    const backendId = Config.getBackendId();
    const record = state.archives.find((entry) => entry.spreadsheetId === backendId);
    if (!backendId || !record) return null;
    const name = record.sheetNames.find((sheetName) => sheetName.endsWith(suffix));
    if (!name) return null;
    return SheetUtils.getSheet(backendId, name);
  }

  function normalizeIdentity(value: string): string {
    return String(value || '').trim().toLowerCase();
  }

  function rowMatchesIdentifier(row: any, identifier: string): boolean {
    const id = normalizeIdentity(identifier);
    if (!id) return false;
    const email = normalizeIdentity(row['email']);
    if (email && email === id) return true;
    const name = `${normalizeIdentity(row['last_name'])}, ${normalizeIdentity(row['first_name'])}`;
    const nameCompact = `${normalizeIdentity(row['last_name'])},${normalizeIdentity(row['first_name'])}`;
    return id === name || id === nameCompact;
  }

  function nextAsYear(current: string): string {
    const normalized = String(current || '').trim().toUpperCase().replace(/\s+/g, '');
    const map: Record<string, string> = {
      AS100: 'AS200',
      AS150: 'AS250',
      AS200: 'AS300',
      AS250: 'AS300',
      AS300: 'AS400',
    };
    return map[normalized] || '';
  }

  function defaultRankForAsYear(asYear: string): string {
    const normalized = String(asYear || '').trim().toUpperCase().replace(/\s+/g, '');
    if (normalized === 'AS100' || normalized === 'AS150') return 'C/4C';
    if (normalized === 'AS200' || normalized === 'AS250' || normalized === 'AS500') return 'C/3C';
    if (normalized === 'AS300' || normalized === 'AS400') return 'C/2d Lt';
    return '';
  }

  function applyDirectoryTransition(state: TransitionState) {
    const draft = state.draft;
    const backendId = Config.getBackendId();
    const sheet = backendId ? SheetUtils.getSheet(backendId, 'Directory Backend') : null;
    if (!sheet) throw new Error('Directory Backend not found.');
    SheetUtils.ensureSchemaColumns(sheet);
    const sourceSheet = backendArchiveSheet(state, 'Directory Backend') || sheet;
    const table = SheetUtils.readTable(sourceSheet);
    const removed = draft.removedCadets.map(normalizeIdentity);
    const overrideEntries = Object.entries(draft.asYearOverrides);
    const roleEntries = Object.entries(draft.roleUpdates);

    const rows = table.rows
      .map((row) => {
        const next = { ...row };
        const originalAsYear = String(row['as_year'] || '').trim().toUpperCase().replace(/\s+/g, '');
        const isDropped = removed.some((id) => rowMatchesIdentifier(row, id));
        const override = overrideEntries.find(([id]) => rowMatchesIdentifier(row, id));

        next['role'] = '';
        next['flight'] = '';
        next['squadron'] = '';

        if (isDropped) {
          next['flight_path_status'] = 'Dropped';
        }

        if (draft.kind === 'academic_year') {
          if (override) {
            next['as_year'] = override[1];
          } else if (!isDropped && originalAsYear === 'AS400') {
            next['as_year'] = row['as_year'] || 'AS400';
            next['flight_path_status'] = 'Commissioned';
          } else {
            const advanced = nextAsYear(String(row['as_year'] || ''));
            if (advanced) next['as_year'] = advanced;
          }
        }

        const defaultRank = defaultRankForAsYear(String(next['as_year'] || ''));
        next['rank'] = defaultRank || '';

        const roleUpdate = roleEntries.find(([id]) => rowMatchesIdentifier(row, id));
        if (roleUpdate) {
          next['role'] = roleUpdate[1].role;
          if (roleUpdate[1].rank) next['rank'] = roleUpdate[1].rank;
        }
        return next;
      })
      .filter((row): row is Record<string, any> => Boolean(row));

    SheetUtils.writeTable(sheet, rows);
  }

  function generateEvents(draft: TransitionDraft): Record<string, any>[] {
    const firstSunday = parseDateOnly(draft.firstWeekSunday);
    const createdAt = new Date().toISOString();
    const rows: Record<string, any>[] = [];
    for (let i = 0; i < draft.trainingWeeks; i++) {
      const tw = draft.firstTrainingWeek + i;
      const weekStart = new Date(firstSunday);
      weekStart.setDate(firstSunday.getDate() + i * 7);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      weekEnd.setHours(23, 59, 0, 0);
      const twLabel = `TW-${tw}`;
      const idBase = `EVT-${draft.term}-${twLabel}`.replace(/[^A-Za-z0-9_-]+/g, '-').toUpperCase();

      rows.push({
        event_id: `${idBase}-SECONDARY`,
        term: draft.term,
        training_week: twLabel,
        event_type: 'Secondary',
        display_name: `${twLabel} Secondary`,
        attendance_column_label: `Secondary ${twLabel}`,
        expected_group: 'All Cadets',
        flight_scope: 'All',
        status: 'Active',
        start_datetime: isoLocal(weekStart),
        end_datetime: isoLocal(weekEnd),
        location: '',
        notes: '',
        created_at: createdAt,
        created_by: 'transition_v2',
      });

      const llabStart = dateForWeekday(weekStart, draft.llabWeekday, draft.llabStartTime);
      rows.push({
        event_id: `${idBase}-LLAB`,
        term: draft.term,
        training_week: twLabel,
        event_type: 'LLAB',
        display_name: `${twLabel} LLAB`,
        attendance_column_label: `LLAB ${twLabel}`,
        expected_group: 'All Cadets',
        flight_scope: 'All',
        status: 'Active',
        start_datetime: isoLocal(llabStart),
        end_datetime: isoLocal(dateForWeekday(weekStart, draft.llabWeekday, draft.llabStartTime, draft.llabMinutes)),
        location: '',
        notes: '',
        created_at: createdAt,
        created_by: 'transition_v2',
      });

      const mandoStart = dateForWeekday(weekStart, draft.mandoWeekday, draft.mandoStartTime);
      rows.push({
        event_id: `${idBase}-MANDO`,
        term: draft.term,
        training_week: twLabel,
        event_type: 'Mando',
        display_name: `${twLabel} Mando`,
        attendance_column_label: `Mando ${twLabel}`,
        expected_group: 'All Cadets',
        flight_scope: 'All',
        status: 'Active',
        start_datetime: isoLocal(mandoStart),
        end_datetime: isoLocal(dateForWeekday(weekStart, draft.mandoWeekday, draft.mandoStartTime, draft.mandoMinutes)),
        location: '',
        notes: '',
        created_at: createdAt,
        created_by: 'transition_v2',
      });

      const thirdStart = dateForWeekday(weekStart, draft.thirdHourWeekday, draft.thirdHourStartTime);
      rows.push({
        event_id: `${idBase}-POC-THIRDHOUR`,
        term: draft.term,
        training_week: twLabel,
        event_type: 'Third Hour',
        display_name: `${twLabel} POC Third Hour`,
        attendance_column_label: `POC Third Hour ${twLabel}`,
        expected_group: 'POC',
        flight_scope: 'All',
        status: 'Active',
        start_datetime: isoLocal(thirdStart),
        end_datetime: isoLocal(dateForWeekday(weekStart, draft.thirdHourWeekday, draft.thirdHourStartTime, draft.thirdHourMinutes)),
        location: '',
        notes: '',
        created_at: createdAt,
        created_by: 'transition_v2',
      });
    }
    return rows;
  }

  function resetSchemaSheet(sheetName: string) {
    const sheet = Config.getBackendSheet(sheetName);
    SheetUtils.ensureSchemaColumns(sheet);
    SheetUtils.writeTable(sheet, []);
  }

  function clearResponseSheet(sheetName: string) {
    let sheet: GoogleAppsScript.Spreadsheet.Sheet;
    try {
      sheet = Config.getBackendSheet(sheetName);
    } catch (err) {
      Log.warn(`Response sheet ${sheetName} not found; skipping clear. Error: ${err}`);
      return;
    }
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow > 1 && lastCol > 0) {
      sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
    }
  }

  function applyRemovedLeadership(draft: TransitionDraft) {
    if (!draft.removedLeadership.length) return;
    const sheet = Config.getBackendSheet('Leadership Backend');
    const rows = SheetUtils.readTable(sheet).rows.filter((row) => !draft.removedLeadership.some((id) => rowMatchesIdentifier(row, id)));
    SheetUtils.writeTable(sheet, rows);
  }

  function runPhase(state: TransitionState, phase: TransitionPhase) {
    const draft = state.draft;
    if (phase === 'archive') {
      if (!state.archives.length) {
        const reusableArchives = latestRegisteredBackendArchive(draft);
        state.archives = reusableArchives.length ? reusableArchives : archiveForTransition(draft);
        saveState(state);
      }
      return;
    }
    if (phase === 'directory') {
      applyDirectoryTransition(state);
      return;
    }
    if (phase === 'logs') {
      resetSchemaSheet('Attendance Backend');
      resetSchemaSheet('Excusals Backend');
      return;
    }
    if (phase === 'events') {
      const eventsSheet = Config.getBackendSheet('Events Backend');
      SheetUtils.ensureSchemaColumns(eventsSheet);
      SheetUtils.writeTable(eventsSheet, generateEvents(draft));
      return;
    }
    if (phase === 'leadership') {
      DirectoryService.syncLeadershipBackendFromDirectory();
      applyRemovedLeadership(draft);
      return;
    }
    if (phase === 'responses') {
      clearResponseSheet(Config.RESOURCE_NAMES.DIRECTORY_FORM_SHEET);
      // Attendance raw responses are not cleared here. The later attendance_form
      // phase unlinks and preserves the entire linked tab before creating a fresh
      // destination, so a transition never destroys the raw submission history.
      clearResponseSheet(Config.RESOURCE_NAMES.EXCUSALS_FORM_SHEET);
      return;
    }
    if (phase === 'directory_artifacts') {
      SetupService.refreshDirectoryArtifacts({ rebuildAttendanceMatrix: true, refreshAttendanceForm: false });
      return;
    }
    if (phase === 'events_artifacts') {
      SetupService.refreshEventsArtifacts();
      return;
    }
    if (phase === 'directory_form') {
      SetupService.rebuildDirectoryForm();
      return;
    }
    if (phase === 'attendance_form') {
      SetupService.rebuildAttendanceForm();
      return;
    }
    if (phase === 'excusals_form') {
      SetupService.refreshExcusalsForm();
      return;
    }
    if (phase === 'triggers') {
      SetupService.reinstallAllTriggers();
      return;
    }
    if (phase === 'reorder') {
      SetupService.reorderFrontendSheets();
      SetupService.reorderBackendSheets();
      return;
    }
    if (phase === 'audit') {
      AuditService.log({
        action: draft.kind === 'academic_year' ? 'transition_new_academic_year_v2' : 'transition_new_semester_v2',
        result: 'ok',
        role: 'menu_operator',
        targetSheet: 'Directory Backend',
        targetTable: 'transition',
        source: 'TransitionService.runTransition',
        version: 'v2',
        metadata: { term: draft.term, weeks: draft.trainingWeeks },
      });
    }
  }

  function applyTransitionState(state: TransitionState, interactive: boolean) {
    clearContinuationTriggers();
    const started = Date.now();
    for (const phase of TRANSITION_PHASES) {
      if (phaseComplete(state, phase)) continue;
      if (Date.now() - started > TRANSITION_CONTINUATION_BUDGET_MS) {
        scheduleContinuation();
        const message = `Transition for ${state.draft.term} paused before phase ${phase}; a continuation trigger will resume it shortly.`;
        if (interactive) alert(message);
        else Log.info(message);
        return;
      }
      Log.info(`Transition ${state.id}: starting phase ${phase}`);
      runPhase(state, phase);
      completePhase(state, phase);
      Log.info(`Transition ${state.id}: completed phase ${phase}`);
      if (Date.now() - started > TRANSITION_CONTINUATION_BUDGET_MS) {
        scheduleContinuation();
        const message = `Transition for ${state.draft.term} paused after phase ${phase}; a continuation trigger will resume it shortly.`;
        if (interactive) alert(message);
        else Log.info(message);
        return;
      }
    }

    Config.deleteScriptProperty(Config.PROPERTY_KEYS.V2_TRANSITION_DRAFT);
    Config.deleteScriptProperty(Config.PROPERTY_KEYS.V2_TRANSITION_STATE);
    clearContinuationTriggers();
    alert(`Transition complete for ${state.draft.term}. Backend rollback archives are hidden and scheduled for deletion after seven days.`);
  }

  function transitionSummary(draft: TransitionDraft): string {
    return [
      `Type: ${draft.kind === 'academic_year' ? 'New academic year' : 'New semester'}`,
      `Term: ${draft.term}`,
      `Training weeks: ${draft.firstTrainingWeek} through ${draft.firstTrainingWeek + draft.trainingWeeks - 1}`,
      `First week starts: ${draft.firstWeekSunday}`,
      `Dropped cadets marked inactive: ${draft.removedCadets.length}`,
      `AS overrides: ${Object.keys(draft.asYearOverrides).length}`,
      `Leadership updates: ${Object.keys(draft.roleUpdates).length}`,
      `Removed cadre/manual leadership rows: ${draft.removedLeadership.length}`,
      '',
      'This will archive current core tabs, update Directory/Leadership/Events, clear Attendance and Excusals logs and form responses, rebuild forms, and refresh derived sheets.',
    ].join('\n');
  }

  export function runTransition(kind: TransitionKind) {
    const inProgress = loadState();
    if (inProgress) {
      const resume = ui().alert(
        'Resume transition already in progress?',
        `A transition for ${inProgress.draft.term} is already applying. Resume remaining phases now?`,
        ui().ButtonSet.YES_NO,
      );
      if (resume === ui().Button.YES) applyTransitionState(inProgress, true);
      return;
    }

    const draft = buildDraft(kind);
    const summary = [
      transitionSummary(draft),
      '',
      'After confirmation, this transition becomes phase-resumable. If Apps Script times out, do not start a new transition; rerun this action or wait for the continuation trigger.',
    ].join('\n');
    const confirmed = ui().alert('Apply SHAMROCK v2 transition?', summary, ui().ButtonSet.OK_CANCEL);
    if (confirmed !== ui().Button.OK) {
      alert('Transition not applied. Draft remains saved for later resume.');
      return;
    }

    const state = createState(draft);
    saveState(state);
    applyTransitionState(state, true);
  }

  export function continueTransition() {
    const state = loadState();
    if (!state) {
      clearContinuationTriggers();
      Log.info('No v2 transition execution state found; continuation skipped.');
      return;
    }
    applyTransitionState(state, false);
  }

  export function cleanupExpiredBackendArchives() {
    const raw = Config.getScriptProperty(Config.PROPERTY_KEYS.V2_BACKEND_ARCHIVES);
    if (!raw) return;
    let records: ArchiveRecord[] = [];
    try {
      records = JSON.parse(raw) as ArchiveRecord[];
    } catch {
      Config.deleteScriptProperty(Config.PROPERTY_KEYS.V2_BACKEND_ARCHIVES);
      return;
    }

    const now = Date.now();
    const remaining: ArchiveRecord[] = [];
    records.forEach((record) => {
      if (new Date(record.expiresAt).getTime() > now) {
        remaining.push(record);
        return;
      }
      try {
        const ss = SpreadsheetApp.openById(record.spreadsheetId);
        record.sheetNames.forEach((name) => {
          const sheet = ss.getSheetByName(name);
          if (sheet) ss.deleteSheet(sheet);
        });
      } catch (err) {
        Log.warn(`Unable to delete expired transition archives: ${err}`);
        remaining.push(record);
      }
    });

    if (remaining.length) Config.setScriptProperty(Config.PROPERTY_KEYS.V2_BACKEND_ARCHIVES, JSON.stringify(remaining));
    else Config.deleteScriptProperty(Config.PROPERTY_KEYS.V2_BACKEND_ARCHIVES);
  }
}
