/** Explicit, paused-by-default host for an isolated standalone Apps Script project. */
import { parseCommand } from '../../../packages/domain/src/index.js';
import {
  AdapterError, attendanceCommandFromForm, captureDecisionDraft, decisionCommandFromDraft,
  enqueueCommand, type AdapterConfig, type ChoiceReference, type DecisionDraft, type FormCatalog,
  type Signer, type Transport, type Journal,
} from './index.js';
import { DECISION_HEADERS, DYNAMIC_DECISION_HEADERS, decisionColumns, readDynamicDecisionSlots,
  type DynamicSlotBinding, type LocatedDecisionSlot } from './decision-slots.js';
import {
  createGoogleSigner, createGoogleTransport, flushGoogleCommands, googleEditActorEmail,
  snapshotGoogleForm, withJournalLock,
  type NativeFormResponse, type ScriptLockPort, type SheetPort, type UtilitiesPort,
} from './apps-script.js';

export const HOST_PROPERTIES = {
  config: 'SHAMROCK_V3_HOST_CONFIG',
  principals: 'SHAMROCK_V3_PRINCIPALS',
  attendanceCatalog: 'SHAMROCK_V3_ATTENDANCE_CATALOG',
  excusalCatalog: 'SHAMROCK_V3_EXCUSAL_CATALOG',
  secret: 'SHAMROCK_V3_BRIDGE_SECRET',
  enabled: 'SHAMROCK_V3_ENABLED',
  setupReceipt: 'SHAMROCK_V3_SETUP_RECEIPT',
} as const;

export const STAGING_HANDLERS = {
  attendance: 'shamrockV3StagingAttendanceSubmit',
  excusal: 'shamrockV3StagingExcusalSubmit',
  decision: 'shamrockV3StagingDecisionEdit',
  flush: 'shamrockV3StagingFlush',
} as const;

export interface ExistingSheetReference { spreadsheetId: string; sheetId: number }
interface FormBinding { formId: string; resourceKey: string }
interface AttendanceBinding extends FormBinding {
  itemRoles: { event: string; scope: string; present: string[]; completeness: string };
}
interface ExcusalBinding extends FormBinding { itemRoles: { event: string; outcome: string; reason: string } }
type DecisionInputBinding = ExistingSheetReference & (DynamicSlotBinding | {
  resourceKey: string;
  mode?: 'fixed';
  /** Frozen target mapping. No code infers identity from an edited/sorted display row. */
  slots: { row: number; slotId: string; requestId: string; baseVersion: number }[];
});
export interface StagingHostConfig {
  version: 1;
  environment: 'staging';
  resourceReview: 'EXISTING_RESOURCES_REVIEWED_FOR_STAGING';
  workerOrigin: string;
  keyId: string;
  generation: number;
  expectedAutomationEmail: string;
  journal: ExistingSheetReference;
  attendance: AttendanceBinding;
  excusal?: ExcusalBinding;
  decisionInput?: DecisionInputBinding;
}

interface HostSheet extends SheetPort { getSheetId(): number }
interface HostSpreadsheet { getId(): string; getSheets(): HostSheet[] }
interface SubmittedFormResponse extends NativeFormResponse { getTimestamp(): Date }
interface HostForm { getId(): string; getResponse(id: string): SubmittedFormResponse }
interface HostTrigger {
  getUniqueId(): string;
  getHandlerFunction(): string;
  getTriggerSource(): unknown;
  getEventType(): unknown;
  getTriggerSourceId(): string | null;
}
interface TriggerCreation { create(): HostTrigger }
interface TriggerBuilder {
  forForm(id: string): { onFormSubmit(): TriggerCreation };
  forSpreadsheet(id: string): { onEdit(): TriggerCreation };
  timeBased(): { everyMinutes(minutes: number): TriggerCreation };
}
export interface HostFetchPort {
  fetch(url: string, options: {
    method: 'get' | 'post'; headers: Record<string, string>; contentType?: string; payload?: string;
    muteHttpExceptions: true; followRedirects: false; validateHttpsCertificates: true;
  }): { getResponseCode(): number; getContentText(): string };
}
export interface StagingHostRuntime {
  properties: { getProperty(key: string): string | null; setProperty(key: string, value: string): unknown };
  utilities: UtilitiesPort & { getUuid(): string };
  urlFetch: HostFetchPort;
  scriptApp: {
    getOAuthToken(): string;
    getProjectTriggers(): HostTrigger[];
    newTrigger(handler: string): TriggerBuilder;
    deleteTrigger(trigger: HostTrigger): void;
    TriggerSource: { FORMS: unknown; SPREADSHEETS: unknown; CLOCK: unknown };
    EventType: { ON_FORM_SUBMIT: unknown; ON_EDIT: unknown; CLOCK: unknown };
  };
  session: { getEffectiveUser(): { getEmail(): string } };
  formApp: { openById(id: string): HostForm };
  spreadsheetApp: { openById(id: string): HostSpreadsheet };
  lockService: { getScriptLock(): ScriptLockPort };
  nowSeconds(): number;
  /** Bind optional native output configuration into the reviewed setup receipt. */
  configurationFingerprint?: () => string;
  /** Must inspect effective sharing/protection state, not just a saved configuration flag. */
  assertJournalPrivate(reference: ExistingSheetReference): void;
  assertDecisionProtection(reference: ExistingSheetReference, protectedHeaders: string[]): void;
  /** Called only after the private-journal lock is released. */
  consumeProjection?: (context: { config: AdapterConfig; signer: Signer; transport: Transport; nowSeconds: () => number }) => unknown;
}

interface PrincipalEntry { email: string; principalId: string; personId?: string }
interface Receipt { fingerprint: string; executor: string; triggers: Record<string, string>; scheduleMinutes: 5; verifiedAfter: number }
interface Context {
  config: StagingHostConfig;
  adapter: AdapterConfig;
  signer: Signer;
  principals: PrincipalEntry[];
  references: Record<string, ChoiceReference>;
  excusalReferences: Record<string, ChoiceReference>;
  fingerprint: string;
  receipt?: Receipt;
}
interface FormEvent { source: { getId(): string }; response: SubmittedFormResponse; triggerUid?: string }
interface DecisionEvent {
  source: { getId(): string };
  range: { getSheet(): { getSheetId(): number }; getRow(): number; getColumn(): number; getNumRows(): number; getNumColumns(): number;
    getNote?(): string; setNote?(note: string): unknown };
  value?: string;
  user?: { getEmail(): string };
  triggerUid?: string;
}
const DECISION_LOCK_WAIT_MS = 25_000;
const BUSY_EDIT_NOTE = '[SHAMROCK retry] A decision edit was not captured by this attempt because the adapter stayed busy. Check the delivery state before retrying. If the intended decision is still unrecorded, clear this input and select it again. Your input was retained.';

function fail(code: string, message: string): never { throw new AdapterError(code, message); }
function record(value: unknown, code = 'invalid_host_config'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, 'A configured object is missing or invalid.');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) fail('invalid_host_config', 'A configured string is missing or invalid.');
  return value;
}
function id(value: unknown): string {
  const result = string(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/.test(result)) fail('invalid_host_config', 'A resource or logical identifier is invalid.');
  return result;
}
function integer(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail('invalid_host_config', 'A configured version or position is invalid.');
  return value;
}
function sheetReference(value: unknown): ExistingSheetReference {
  const v = record(value);
  return { spreadsheetId: id(v.spreadsheetId), sheetId: integer(v.sheetId, 0) };
}
function email(value: unknown): string {
  const result = string(value).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail('invalid_host_config', 'A configured account identity is invalid.');
  return result;
}

export function parseStagingHostConfig(value: unknown): StagingHostConfig {
  const v = record(value);
  if (v.version !== 1 || v.environment !== 'staging' || v.resourceReview !== 'EXISTING_RESOURCES_REVIEWED_FOR_STAGING') {
    fail('staging_configuration_required', 'An explicit reviewed staging configuration is required.');
  }
  const origin = string(v.workerOrigin);
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(origin)) fail('invalid_host_config', 'The staging Worker must use an HTTPS origin.');
  const attendance = record(v.attendance); const roles = record(attendance.itemRoles);
  if (!Array.isArray(roles.present) || roles.present.length === 0 || roles.present.length > 30) fail('invalid_host_config', 'Attendance checkbox item bindings are required.');
  const result: StagingHostConfig = {
    version: 1, environment: 'staging', resourceReview: 'EXISTING_RESOURCES_REVIEWED_FOR_STAGING',
    workerOrigin: origin, keyId: id(v.keyId), generation: integer(v.generation), expectedAutomationEmail: email(v.expectedAutomationEmail),
    journal: sheetReference(v.journal),
    attendance: { formId: id(attendance.formId), resourceKey: id(attendance.resourceKey), itemRoles: {
      event: id(roles.event), scope: id(roles.scope), present: roles.present.map(id), completeness: id(roles.completeness),
    } },
  };
  if (v.excusal !== undefined) {
    const form = record(v.excusal); const items = record(form.itemRoles);
    result.excusal = { formId: id(form.formId), resourceKey: id(form.resourceKey), itemRoles: { event: id(items.event), outcome: id(items.outcome), reason: id(items.reason) } };
    if (result.excusal.formId === result.attendance.formId) fail('invalid_host_config', 'Attendance and excusal source Forms must be distinct.');
  }
  if (v.decisionInput !== undefined) {
    const input = record(v.decisionInput);
    if (input.mode === 'projection') {
      const maxSlots = integer(input.maxSlots);
      if (maxSlots > 500 || input.slots !== undefined) fail('invalid_host_config', 'Projection decision slots need a bound of 1–500 and cannot also use fixed bindings.');
      result.decisionInput = { ...sheetReference(input), resourceKey: id(input.resourceKey), mode: 'projection', maxSlots };
    } else {
      if (input.mode !== undefined && input.mode !== 'fixed') fail('invalid_host_config', 'The decision slot mode is invalid.');
      if (!Array.isArray(input.slots) || input.slots.length === 0 || input.slots.length > 25) fail('invalid_host_config', 'Configure a bounded set of fixed decision slots.');
      const slots = input.slots.map(raw => {
      const slot = record(raw);
      const row = integer(slot.row, 3);
      if (row > 2002) fail('invalid_host_config', 'A fixed slot exceeds the bounded input table.');
      return { row, slotId: id(slot.slotId), requestId: id(slot.requestId), baseVersion: integer(slot.baseVersion) };
      });
      if (new Set(slots.map(s => s.row)).size !== slots.length || new Set(slots.map(s => s.slotId)).size !== slots.length) fail('invalid_host_config', 'Decision slot identities and rows must be unique.');
      result.decisionInput = { ...sheetReference(input), resourceKey: id(input.resourceKey), ...(input.mode === 'fixed' ? { mode: 'fixed' as const } : {}), slots };
    }
    if (result.decisionInput.spreadsheetId === result.journal.spreadsheetId) fail('invalid_host_config', 'The private journal must not share the decision-input workbook.');
  }
  return result;
}

export function createStagingHost(runtime: StagingHostRuntime) {
  const props = runtime.properties;
  function propertyJson(key: string): { text: string; value: unknown } {
    const text = props.getProperty(key);
    if (!text || encodeURIComponent(text).replace(/%[A-F0-9]{2}/g, 'x').length > 8000) fail('invalid_host_config', 'Required configuration is missing or exceeds the small staging limit.');
    try { return { text, value: JSON.parse(text) }; }
    catch { return fail('invalid_host_config', 'Configuration contains invalid JSON.'); }
  }
  function context(requireReceipt: boolean): Context {
    const cfg = propertyJson(HOST_PROPERTIES.config);
    const config = parseStagingHostConfig(cfg.value);
    let executor = '';
    try { executor = runtime.session.getEffectiveUser().getEmail().trim().toLowerCase(); } catch { /* fail closed below */ }
    if (!executor || executor !== config.expectedAutomationEmail) fail('wrong_automation_identity', 'Run this host under the configured staging automation account.');
    const secret = props.getProperty(HOST_PROPERTIES.secret) || '';
    const signer = createGoogleSigner(runtime.utilities, secret);
    const registry = propertyJson(HOST_PROPERTIES.principals);
    const entries = record(registry.value).entries;
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 50) fail('invalid_host_config', 'A bounded enrolled-principal registry is required.');
    const principals = entries.map(raw => {
      const p = record(raw);
      return { email: email(p.email), principalId: id(p.principalId), ...(p.personId === undefined ? {} : { personId: id(p.personId) }) };
    });
    if (new Set(principals.map(p => p.email)).size !== principals.length) fail('invalid_host_config', 'Verified email mappings must be unique.');
    const catalog = propertyJson(HOST_PROPERTIES.attendanceCatalog);
    const references = record(record(catalog.value).references) as Record<string, ChoiceReference>;
    const excusalCatalog = config.excusal ? propertyJson(HOST_PROPERTIES.excusalCatalog) : { text: '', value: { references: {} } };
    const excusalReferences = record(record(excusalCatalog.value).references) as Record<string, ChoiceReference>;
    const extraFingerprint = runtime.configurationFingerprint?.() ?? '';
    if (typeof extraFingerprint !== 'string' || extraFingerprint.length > 1024) fail('invalid_host_config', 'Additional host bindings are invalid.');
    const fingerprint = signer.sha256([cfg.text, registry.text, catalog.text, excusalCatalog.text, extraFingerprint].join('\n'));
    let receipt: Receipt | undefined;
    const saved = props.getProperty(HOST_PROPERTIES.setupReceipt);
    if (saved) { try { receipt = JSON.parse(saved) as Receipt; } catch { /* invalid receipt fails readiness */ } }
    if (requireReceipt && (!receipt || receipt.fingerprint !== fingerprint || receipt.executor !== executor || receipt.scheduleMinutes !== 5 || !Number.isSafeInteger(receipt.verifiedAfter) || receipt.verifiedAfter < 1 || !receipt.triggers || typeof receipt.triggers !== 'object' || Array.isArray(receipt.triggers))) {
      fail('setup_required', 'Configuration changed or setup has not been verified. Run staging setup while paused.');
    }
    return { config, signer, principals, references, excusalReferences, fingerprint, receipt,
      adapter: { baseUrl: config.workerOrigin, keyId: config.keyId, environment: 'staging', generation: config.generation } };
  }
  function openSheet(ref: ExistingSheetReference): HostSheet {
    let book: HostSpreadsheet;
    try { book = runtime.spreadsheetApp.openById(ref.spreadsheetId); }
    catch { return fail('configured_resource_unavailable', 'A configured existing workbook is unavailable; no replacement was created.'); }
    if (book.getId() !== ref.spreadsheetId) fail('wrong_resource', 'The opened workbook did not match its binding.');
    const sheet = book.getSheets().find(s => s.getSheetId() === ref.sheetId);
    if (!sheet) fail('configured_resource_unavailable', 'A configured existing tab is missing; no replacement was created.');
    return sheet;
  }
  function openJournal(ctx: Context): HostSheet {
    runtime.assertJournalPrivate(ctx.config.journal);
    return openSheet(ctx.config.journal);
  }
  function verifiedForm(binding: FormBinding): HostForm {
    let form: HostForm;
    try { form = runtime.formApp.openById(binding.formId); }
    catch { return fail('configured_resource_unavailable', 'A configured existing Form is unavailable; no replacement was created.'); }
    if (form.getId() !== binding.formId) fail('wrong_resource', 'The opened Form did not match its binding.');
    const token = runtime.scriptApp.getOAuthToken();
    if (!token) fail('forms_api_authorization_required', 'Authorize the Forms metadata read scope for the staging host.');
    const response = runtime.urlFetch.fetch(`https://forms.googleapis.com/v1/forms/${encodeURIComponent(binding.formId)}?fields=formId,settings.emailCollectionType`, {
      method: 'get', headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true,
      followRedirects: false, validateHttpsCertificates: true,
    });
    if (response.getResponseCode() !== 200) fail('forms_verification_failed', 'The Forms API could not verify responder-email collection.');
    let metadata: Record<string, unknown>;
    try { metadata = record(JSON.parse(response.getContentText()), 'forms_verification_failed'); }
    catch { return fail('forms_verification_failed', 'The Forms API returned invalid metadata.'); }
    const settings = metadata.settings && typeof metadata.settings === 'object' ? metadata.settings as Record<string, unknown> : {};
    if (metadata.formId !== binding.formId || settings.emailCollectionType !== 'VERIFIED') {
      fail('verified_email_required', 'The configured Form must collect signed-in verified email, not responder-entered email.');
    }
    return form;
  }
  function openDecisionInput(reference: DecisionInputBinding): HostSheet {
    const headers = reference.mode === 'projection' ? DYNAMIC_DECISION_HEADERS : DECISION_HEADERS;
    runtime.assertDecisionProtection(reference, headers.filter(header => header !== 'draft_decision'));
    return openSheet(reference);
  }
  function slotsFor(ctx: Context, sheet: HostSheet, binding: DecisionInputBinding): LocatedDecisionSlot[] {
    return binding.mode === 'projection' ? readDynamicDecisionSlots(sheet, { binding, config: ctx.adapter, signer: ctx.signer }).slots : binding.slots;
  }
  function checkSlot(sheet: HostSheet, columns: Record<string, number>, slot: LocatedDecisionSlot) {
    const read = (header: string) => sheet.getRange(slot.row, columns[header], 1, 1).getValues()[0][0];
    if (read('slot_id') !== slot.slotId || read('request_id') !== slot.requestId || read('base_version') !== slot.baseVersion) {
      fail('draft_target_changed', 'A fixed decision slot differs from its reviewed target; input was retained.');
    }
    return read;
  }
  function preflight(ctx: Context) {
    const journal = openJournal(ctx);
    // Initialize only the already configured private tab, never a new file/tab.
    withJournalLock(journal, runtime.lockService.getScriptLock(), j => j.due(0, 1));
    verifiedForm(ctx.config.attendance);
    if (ctx.config.excusal) verifiedForm(ctx.config.excusal);
    if (ctx.config.decisionInput) {
      const binding = ctx.config.decisionInput; const sheet = openDecisionInput(binding);
      const cols = decisionColumns(sheet, binding.mode === 'projection');
      if (binding.mode === 'projection') readDynamicDecisionSlots(sheet, { binding, config: ctx.adapter, signer: ctx.signer });
      else {
        const rows = sheet.getRange(3, 1, Math.max(...binding.slots.map(slot => slot.row)) - 2, sheet.getLastColumn()).getValues();
        for (const slot of binding.slots) {
          const values = rows[slot.row - 3];
          if (values[cols.slot_id - 1] !== slot.slotId || values[cols.request_id - 1] !== slot.requestId || values[cols.base_version - 1] !== slot.baseVersion) fail('draft_target_changed', 'A fixed decision slot differs from its reviewed target.');
        }
      }
    }
  }
  function specs(ctx: Context) {
    const { TriggerSource: source, EventType: event } = runtime.scriptApp;
    return [
      { handler: STAGING_HANDLERS.attendance, source: source.FORMS, event: event.ON_FORM_SUBMIT, resource: ctx.config.attendance.formId, kind: 'form' },
      ...(ctx.config.excusal ? [{ handler: STAGING_HANDLERS.excusal, source: source.FORMS, event: event.ON_FORM_SUBMIT, resource: ctx.config.excusal.formId, kind: 'form' }] : []),
      ...(ctx.config.decisionInput ? [{ handler: STAGING_HANDLERS.decision, source: source.SPREADSHEETS, event: event.ON_EDIT, resource: ctx.config.decisionInput.spreadsheetId, kind: 'sheet' }] : []),
      { handler: STAGING_HANDLERS.flush, source: source.CLOCK, event: event.CLOCK, resource: null, kind: 'clock' },
    ];
  }
  function matches(trigger: HostTrigger, spec: ReturnType<typeof specs>[number]): boolean {
    return trigger.getHandlerFunction() === spec.handler && trigger.getTriggerSource() === spec.source && trigger.getEventType() === spec.event
      && (spec.kind === 'clock' || trigger.getTriggerSourceId() === spec.resource);
  }
  function checkTriggers(ctx: Context) {
    const list = runtime.scriptApp.getProjectTriggers();
    for (const spec of specs(ctx)) {
      const found = list.filter(t => t.getHandlerFunction() === spec.handler);
      if (found.length !== 1 || !matches(found[0], spec) || ctx.receipt?.triggers[spec.handler] !== found[0].getUniqueId()) {
        fail('trigger_repair_required', 'The staging trigger manifest needs repair under its configured owner.');
      }
    }
  }
  function checkTriggerEvent(ctx: Context, name: string, uid?: string) {
    if (!uid || ctx.receipt?.triggers[name] !== String(uid)) fail('unrecognized_trigger', 'This event is not from a verified staging trigger.');
  }
  function ready(): Context | undefined {
    if (props.getProperty(HOST_PROPERTIES.enabled) !== 'true') return undefined;
    return context(true);
  }
  function resolver(ctx: Context) {
    return { resolveVerifiedEmail: (address: string) => ctx.principals.find(p => p.email === address)?.principalId };
  }
  function savedDraft(read: (header: string) => unknown, slot: LocatedDecisionSlot, binding: DecisionInputBinding): DecisionDraft | undefined {
    const raw = read('draft_json');
    if (raw === '' && read('draft_id') === '') return undefined;
    let draft: DecisionDraft;
    try { draft = JSON.parse(String(raw)) as DecisionDraft; } catch { return fail('draft_capture_failed', 'The saved draft is incomplete; retain it for review.'); }
    if (!draft || draft.slotId !== slot.slotId || draft.requestId !== slot.requestId || draft.baseVersion !== slot.baseVersion
      || draft.resourceKey !== binding.resourceKey || draft.draftId !== read('draft_id')
      || !['ready', 'confirmation-required'].includes(draft.status)) fail('draft_target_changed', 'The saved draft does not match its immutable row.');
    captureDecisionDraft({ slot, draftId: draft.draftId, resourceKey: draft.resourceKey, decision: draft.decision, reason: draft.reason, editedCellCount: 1 }, { resolveVerifiedEmail: () => undefined });
    if (draft.status === 'confirmation-required' && draft.actor) fail('draft_target_changed', 'An unconfirmed draft cannot assert an actor.');
    return draft;
  }
  function reconcileDecisionStates(ctx: Context, journal: Journal) {
    const binding = ctx.config.decisionInput;
    if (!binding) return { reconciled: 0 };
    const sheet = openDecisionInput(binding); const cols = decisionColumns(sheet, binding.mode === 'projection');
    const slots = slotsFor(ctx, sheet, binding);
    const count = Math.max(0, ...slots.map(slot => slot.row - 2));
    const values = count ? sheet.getRange(3, 1, count, sheet.getLastColumn()).getValues() : [];
    const drafts = slots.map(slot => {
      const read = (header: string) => values[slot.row - 3][cols[header] - 1];
      if (read('slot_id') !== slot.slotId || read('request_id') !== slot.requestId || read('base_version') !== slot.baseVersion) fail('draft_target_changed', 'A decision row moved after capture.');
      return { slot, read };
    })
      .map(value => ({ ...value, draft: savedDraft(value.read, value.slot, binding) }));
    const entries = new Map(journal.find(drafts.filter(row => row.draft?.status === 'ready').map(row => `draft.${row.draft!.draftId}`)).map(entry => [entry.commandId, entry]));
    let reconciled = 0;
    const states = values.map(row => [row[cols.draft_state - 1]]);
    for (const { slot, read, draft } of drafts) {
      if (!draft) continue;
      let state = `Confirmation required: ${draft.decision}`;
      if (draft.status === 'ready') {
        const command = decisionCommandFromDraft(draft, ctx.adapter); const body = JSON.stringify(command);
        const entry = entries.get(command.commandId);
        if (entry && (entry.body !== body || entry.bodyHash !== ctx.signer.sha256(body))) fail('journal_integrity', 'The saved outcome belongs to a different decision payload.');
        const label = !entry ? 'Not queued; retry the saved decision' : ({
          pending: entry.attempts ? 'Retry pending' : 'Queued', committed: 'Committed', conflict: 'Conflict; review recorded version',
          rejected: 'Failed; review rejected request', 'needs-attention': 'Needs attention; delivery unresolved',
        } as const)[entry.status];
        state = `${label}: ${draft.decision}`;
      }
      if (read('draft_decision') !== draft.decision) state = `Input changed; saved ${state}`;
      if (read('draft_state') !== state) {
        states[slot.row - 3] = [state];
        reconciled++;
      }
    }
    if (reconciled) {
      // One bounded status-column write, never per-row Google round trips or a
      // rectangular write across editable input / immutable target columns.
      sheet.getRange(3, cols.draft_state, count, 1).setValues(states);
      const after = sheet.getRange(3, 1, count, sheet.getLastColumn()).getValues();
      for (const { slot, read } of drafts) {
        const current = after[slot.row - 3];
        for (const key of ['slot_id', 'request_id', 'base_version', 'draft_id', 'draft_json', 'draft_decision']) {
          if (current[cols[key] - 1] !== read(key)) fail('draft_capture_failed', 'A decision row changed while reconciling its outcome; retain it for review.');
        }
        if (current[cols.draft_state - 1] !== states[slot.row - 3][0]) fail('draft_capture_failed', 'The delivery status did not read back; retain the saved journal outcome.');
      }
    }
    return { reconciled };
  }
  function flushWith(ctx: Context) {
    let commands;
    try { commands = flushGoogleCommands(openJournal(ctx), runtime.lockService.getScriptLock(), runtime.urlFetch, ctx.adapter, ctx.signer, runtime.nowSeconds()); }
    finally { withJournalLock(openJournal(ctx), runtime.lockService.getScriptLock(), journal => reconcileDecisionStates(ctx, journal)); }
    const projection = runtime.consumeProjection?.({ config: ctx.adapter, signer: ctx.signer, transport: createGoogleTransport(runtime.urlFetch), nowSeconds: runtime.nowSeconds });
    return { status: 'processed', commands, projection: projection === undefined ? 'not-configured' : projection };
  }
  function assertResponseTime(ctx: Context, response: SubmittedFormResponse) {
    let submitted = NaN;
    try { submitted = response.getTimestamp().getTime(); } catch { /* Native timestamp is mandatory. */ }
    if (!Number.isFinite(submitted) || !ctx.receipt || submitted < ctx.receipt.verifiedAfter * 1000 || submitted > (runtime.nowSeconds() + 60) * 1000) {
      fail('historical_response_review_required', 'This response predates verified staging setup or lacks a valid native timestamp; retain it for explicit review.');
    }
  }
  function acceptAttendance(ctx: Context, source: { getId(): string }, response: SubmittedFormResponse) {
    if (source.getId() !== ctx.config.attendance.formId) fail('wrong_source', 'This is not the configured attendance Form.');
    verifiedForm(ctx.config.attendance);
    assertResponseTime(ctx, response);
    const catalog: FormCatalog = { nativeFormId: ctx.config.attendance.formId, resourceKey: ctx.config.attendance.resourceKey, itemRoles: ctx.config.attendance.itemRoles, references: ctx.references };
    const command = attendanceCommandFromForm(snapshotGoogleForm(source, response, true), catalog, resolver(ctx), ctx.adapter, ctx.signer);
    withJournalLock(openJournal(ctx), runtime.lockService.getScriptLock(), j => enqueueCommand(command, j, ctx.signer));
    return flushWith(ctx);
  }
  function acceptExcusal(ctx: Context, source: { getId(): string }, response: SubmittedFormResponse) {
    const binding = ctx.config.excusal;
    if (!binding || source.getId() !== binding.formId) fail('wrong_source', 'This is not the configured excusal Form.');
    verifiedForm(binding);
    assertResponseTime(ctx, response);
    const snapshot = snapshotGoogleForm(source, response, true);
    const principal = ctx.principals.find(p => p.email === snapshot.responderEmail.trim().toLowerCase());
    if (!principal?.personId) fail('confirmation_required', 'The verified responder needs an enrolled cadet identity.');
    const answer = (item: string) => { const value = snapshot.answers[item]; if (typeof value !== 'string') fail('invalid_form_answer', 'A required scalar excusal answer is missing.'); return value; };
    const selection = snapshot.answers[binding.itemRoles.event];
    const selected = typeof selection === 'string' ? [selection] : selection;
    if (!Array.isArray(selected) || selected.length < 1 || selected.length > 25) fail('invalid_form_answer', 'Select between one and 25 reviewed excusal events.');
    const events = selected.map(choice => {
      const token = /\[sr:([A-Za-z0-9_.:-]{1,96})\]$/.exec(choice)?.[1];
      const event = token ? ctx.excusalReferences[token] : undefined;
      if (!event || event.kind !== 'event') fail('unknown_choice', 'An excusal event needs a reviewed choice mapping.');
      return event.eventId;
    });
    if (new Set(events).size !== events.length) fail('invalid_form_answer', 'A native excusal submission cannot repeat an event.');
    const identity = ctx.signer.sha256(`${binding.resourceKey}\n${snapshot.responseId}\n1`);
    const shared = { personId: principal.personId, requestedOutcome: answer(binding.itemRoles.outcome), reason: answer(binding.itemRoles.reason) };
    const command = parseCommand({
      commandId: `form.${identity}`, contractVersion: 1, environment: 'staging', generation: ctx.config.generation,
      actor: { principalId: principal.principalId, evidence: 'google-form' },
      source: { kind: 'form', resourceKey: binding.resourceKey, submissionId: snapshot.responseId, revision: 1 },
      ...(typeof selection === 'string'
        ? { operation: 'excusal.submit', payload: { ...shared, requestId: `request.${identity}`, eventId: events[0] } }
        : { operation: 'excusal.submitMany', payload: { ...shared, events: events.map(eventId => ({ eventId,
          requestId: `request.${ctx.signer.sha256(`${binding.resourceKey}\n${snapshot.responseId}\n1\n${eventId}`)}`,
        })) } }),
    });
    withJournalLock(openJournal(ctx), runtime.lockService.getScriptLock(), j => enqueueCommand(command, j, ctx.signer));
    return flushWith(ctx);
  }
  return {
    setup() {
      props.setProperty(HOST_PROPERTIES.enabled, 'false');
      const ctx = context(false);
      preflight(ctx);
      const desired = specs(ctx); const ownNames = Object.values(STAGING_HANDLERS) as string[];
      const list = runtime.scriptApp.getProjectTriggers(); const kept: Record<string, string> = {};
      for (const trigger of list) {
        if (!ownNames.includes(trigger.getHandlerFunction())) continue;
        const spec = desired.find(s => s.handler === trigger.getHandlerFunction());
        const knownClock = spec?.kind !== 'clock' || (ctx.receipt?.triggers[spec.handler] === trigger.getUniqueId() && ctx.receipt?.scheduleMinutes === 5);
        if (spec && matches(trigger, spec) && !kept[spec.handler] && knownClock) kept[spec.handler] = trigger.getUniqueId();
        else runtime.scriptApp.deleteTrigger(trigger); // Failure stops before any replacement creation.
      }
      for (const spec of desired) {
        if (kept[spec.handler]) continue;
        const builder = runtime.scriptApp.newTrigger(spec.handler);
        const trigger = spec.kind === 'form' ? builder.forForm(spec.resource!).onFormSubmit().create()
          : spec.kind === 'sheet' ? builder.forSpreadsheet(spec.resource!).onEdit().create()
          : builder.timeBased().everyMinutes(5).create();
        kept[spec.handler] = trigger.getUniqueId();
      }
      const receipt: Receipt = { fingerprint: ctx.fingerprint, executor: ctx.config.expectedAutomationEmail, scheduleMinutes: 5, verifiedAfter: integer(runtime.nowSeconds()), triggers: kept };
      props.setProperty(HOST_PROPERTIES.setupReceipt, JSON.stringify(receipt));
      checkTriggers({ ...ctx, receipt });
      return { status: 'ready-paused', triggers: desired.length, verifiedForms: ctx.config.excusal ? 2 : 1 };
    },
    pause() { props.setProperty(HOST_PROPERTIES.enabled, 'false'); return { status: 'paused' }; },
    resume() {
      props.setProperty(HOST_PROPERTIES.enabled, 'false');
      const ctx = context(true); preflight(ctx); checkTriggers(ctx);
      props.setProperty(HOST_PROPERTIES.enabled, 'true');
      return { status: 'enabled', scope: 'configured-staging-resources' };
    },
    flush() { const ctx = ready(); return ctx ? flushWith(ctx) : { status: 'paused' }; },
    onAttendanceSubmit(event: FormEvent) {
      const ctx = ready(); if (!ctx) return { status: 'paused' };
      checkTriggerEvent(ctx, STAGING_HANDLERS.attendance, event?.triggerUid);
      return acceptAttendance(ctx, event.source, event.response);
    },
    onExcusalSubmit(event: FormEvent) {
      const ctx = ready(); if (!ctx) return { status: 'paused' };
      checkTriggerEvent(ctx, STAGING_HANDLERS.excusal, event?.triggerUid);
      return acceptExcusal(ctx, event.source, event.response);
    },
    replayAttendanceResponse(responseId: string) {
      const ctx = ready(); if (!ctx) return { status: 'paused' };
      const form = verifiedForm(ctx.config.attendance);
      return acceptAttendance(ctx, form, form.getResponse(id(responseId)));
    },
    replayExcusalResponse(responseId: string) {
      const ctx = ready(); if (!ctx) return { status: 'paused' };
      if (!ctx.config.excusal) fail('wrong_source', 'No staging excusal Form is configured.');
      const form = verifiedForm(ctx.config.excusal);
      return acceptExcusal(ctx, form, form.getResponse(id(responseId)));
    },
    onDecisionEdit(event: DecisionEvent) {
      const ctx = ready(); if (!ctx) return { status: 'paused' };
      checkTriggerEvent(ctx, STAGING_HANDLERS.decision, event?.triggerUid);
      // Native event evidence is frozen before any potentially blocking lock wait.
      // Never replace it with the cell's later value or the trigger owner's identity.
      const frozen = { sourceId: event.source.getId(), sheetId: event.range.getSheet().getSheetId(),
        row: event.range.getRow(), column: event.range.getColumn(), rows: event.range.getNumRows(), columns: event.range.getNumColumns(),
        value: event.value, actorEmail: googleEditActorEmail(event), triggerUid: event.triggerUid };
      const binding = ctx.config.decisionInput;
      if (!binding || frozen.sourceId !== binding.spreadsheetId) fail('wrong_source', 'This is not the configured decision workbook.');
      if (frozen.sheetId !== binding.sheetId) return { status: 'ignored' };
      const sheet = openDecisionInput(binding); const cols = decisionColumns(sheet, binding.mode === 'projection');
      if (frozen.column > cols.draft_decision || frozen.column + frozen.columns <= cols.draft_decision) return { status: 'ignored' };
      if (frozen.rows !== 1 || frozen.columns !== 1) fail('bulk_review_required', 'Keep the pasted input and review it as a frozen bulk draft.');
      if (frozen.row < 3 || (binding.mode === 'projection' ? frozen.row > binding.maxSlots + 2 : !binding.slots.some(slot => slot.row === frozen.row))) {
        fail('unknown_draft_slot', 'This row is outside the configured decision input area.');
      }
      function retryNote(show: boolean): 'shown' | 'cleared' | 'unavailable' | 'input-changed' {
        try {
          if (!event.range.getNote || !event.range.setNote) return 'unavailable';
          // A timeout notice describes this attempt, never a later selection. Notes
          // are presentation only; target/draft/status/journal cells need the lock.
          if (show && (decisionColumns(sheet, binding!.mode === 'projection').draft_decision !== frozen.column
            || sheet.getRange(frozen.row, frozen.column, 1, 1).getValues()[0][0] !== frozen.value)) return 'input-changed';
          const current = event.range.getNote();
          const clean = current.replace(`\n\n${BUSY_EDIT_NOTE}`, '').replace(BUSY_EDIT_NOTE, '');
          const next = show ? `${clean}${clean ? '\n\n' : ''}${BUSY_EDIT_NOTE}` : clean;
          if (next !== current) event.range.setNote(next);
          return show ? 'shown' : 'cleared';
        } catch { return 'unavailable'; }
      }
      let result;
      try { result = withJournalLock(openJournal(ctx), runtime.lockService.getScriptLock(), journal => {
        const currentContext = ready();
        if (!currentContext) return { status: 'paused' };
        if (currentContext.fingerprint !== ctx.fingerprint) fail('setup_required', 'Staging configuration changed while this edit waited; retain the input for review.');
        checkTriggerEvent(currentContext, STAGING_HANDLERS.decision, frozen.triggerUid);
        // Native lock acquisition invalidates cached metadata: ownership/sharing
        // and protections may drift during the wait without a config edit.
        openJournal(ctx);
        openDecisionInput(binding);
        const currentCols = decisionColumns(sheet, binding.mode === 'projection');
        if (currentCols.draft_decision !== frozen.column) fail('draft_target_changed', 'The decision columns moved after this edit.');
        const slot = slotsFor(ctx, sheet, binding).find(s => s.row === frozen.row);
        if (!slot) fail('unknown_draft_slot', 'This row has no reviewed immutable request binding.');
        const read = checkSlot(sheet, currentCols, slot);
        if (read('draft_decision') !== frozen.value) fail('draft_input_changed', 'This delayed edit no longer matches the current input; no command was sent.');
        const prior = savedDraft(read, slot, binding);
        if (prior) {
          // A captured slot is never rebound, even if its outcome is terminal. A later
          // recorded version gets a fresh row; edits here retain the original payload.
          if (prior.decision !== frozen.value || prior.status !== 'ready') {
            reconcileDecisionStates(ctx, journal);
            return { status: prior.status === 'ready' ? 'saved-draft-retained' : 'confirmation-required' };
          }
          enqueueCommand(decisionCommandFromDraft(prior, ctx.adapter), journal, ctx.signer);
          reconcileDecisionStates(ctx, journal);
          return { status: 'queued' };
        }
        const candidate = captureDecisionDraft({ slot, draftId: runtime.utilities.getUuid(), resourceKey: binding.resourceKey,
          decision: frozen.value ?? '', reason: 'Decision selected in the staging spreadsheet.', editedCellCount: 1,
          eventUserEmail: frozen.actorEmail,
        }, resolver(ctx));
        const draft = candidate;
        const body = JSON.stringify(draft);
        sheet.getRange(slot.row, currentCols.draft_id, 1, 1).setValues([[draft.draftId]]);
        sheet.getRange(slot.row, currentCols.draft_json, 1, 1).setValues([[body]]);
        sheet.getRange(slot.row, currentCols.draft_state, 1, 1).setValues([[draft.status === 'ready' ? `Not queued; retry the saved decision: ${draft.decision}` : `Confirmation required: ${draft.decision}`]]);
        if (read('draft_id') !== draft.draftId || read('draft_json') !== body) fail('draft_capture_failed', 'The draft could not be verified; no command was sent.');
        if (draft.status !== 'ready') return { status: 'confirmation-required' };
        enqueueCommand(decisionCommandFromDraft(draft, ctx.adapter), journal, ctx.signer);
        reconcileDecisionStates(ctx, journal);
        return { status: 'queued' };
      }, {}, DECISION_LOCK_WAIT_MS); }
      catch (error) {
        if (error instanceof AdapterError && error.code === 'adapter_busy') return { status: 'attention-required', reason: 'decision-not-captured-adapter-busy', inputRetained: true, notice: retryNote(true) };
        throw error;
      }
      if (result.status !== 'paused') retryNote(false);
      if (result.status !== 'queued') return result;
      try { return flushWith(ctx); }
      catch (error) {
        // The durable capture succeeded. A separate dispatcher/publisher winning
        // the next lock must not relabel this edit as uncaptured or invent a retry.
        if (error instanceof AdapterError && ['adapter_busy', 'projection_busy'].includes(error.code)) return { status: 'captured', delivery: 'deferred' };
        throw error;
      }
    },
  };
}
