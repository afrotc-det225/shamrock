/** Optional standalone Google host. Config and journals remain in automation-owned Drive JSON. */
import { createPrivateCheckpoint } from './private-checkpoint.js';
import { AdapterError, type AdapterConfig, type Signer } from './index.js';
import { createGoogleSigner } from './apps-script.js';
import { HOST_PROPERTIES, parseStagingHostConfig } from './staging-host.js';
import { CONFIG_FILE_ID_PROPERTY } from './staging-config.js';
import { consumeFormsRefresh, type FormsClaim, type FormsState } from './forms-refresh.js';
import { formReadFingerprint, formsCanonical, type ManagedFormBinding, type NativeFormRead } from './forms-publication.js';
import { commandsFromManagedForm, directoryDraftFromManagedForm, directoryReviewCommand, verifyDirectoryPhoto,
  type DirectorySubmissionDraft, type FormIntakeBinding, type FormPrincipal, type VerifiedFormSubmission } from './forms-intake.js';
import type { DirectoryProfile } from '../../../packages/domain/src/admin.js';

export const FORMS_PROPERTIES = { config: 'SHAMROCK_V3_FORMS_CONFIG', pause: 'SHAMROCK_V3_FORMS_PAUSED', intakePause: 'SHAMROCK_V3_FORM_INTAKE_PAUSED', setup: 'SHAMROCK_V3_FORMS_SETUP', controlReceipt: 'SHAMROCK_V3_FORMS_CONTROL_RECEIPT' } as const;
export const MANAGED_FORM_HANDLERS = { attendance: 'shamrockV3ManagedAttendanceSubmit', excusals: 'shamrockV3ManagedExcusalSubmit', directory: 'shamrockV3ManagedDirectorySubmit' } as const;
export interface NativeFormsConfig {
  version: 1; environment: 'staging'; generation: number; enabled: boolean; intakeEnabled: boolean;
  resourceReview: 'EXISTING_FORMS_REVIEWED_FOR_STAGING'; principalId: string; workerId: string;
  stateFileId: string; intakeFileId: string; reviewResourceKey: string; principals: FormPrincipal[];
  controlRequest?: { requestId: string; sequence: number; action: 'setup' | 'resume-publication' | 'resume-intake' | 'pause'; stateSha256: string; intakeSha256: string };
  forms: (ManagedFormBinding & { allowedEditors: string[]; intake: FormIntakeBinding })[];
}
type CommandEntry = { command: any; path: '/v1/commands' | '/v1/admin/commands'; status: 'queued' | 'committed' | 'conflict' | 'rejected'; receipt?: unknown };
interface IntakeEntry {
  id: string; source: VerifiedFormSubmission; formKey: string; sourceHash: string;
  status: 'captured' | 'queued' | 'pending-review' | 'committed' | 'conflict' | 'rejected';
  commands: CommandEntry[]; directory?: DirectorySubmissionDraft; issue?: string;
}
interface IntakeState { version: 1; environment: 'staging'; generation: number; entries: Record<string, IntakeEntry>; enrollments?: Record<string, {principalId: string; personId: string}> }
export interface NativeFormsServices {
  PropertiesService: { getScriptProperties(): { getProperty(k: string): string | null; setProperty(k: string, v: string): unknown } };
  Utilities: Parameters<typeof createGoogleSigner>[0] & { getUuid(): string };
  ScriptApp: any; Session: { getEffectiveUser(): { getEmail(): string }; getActiveUser(): { getEmail(): string } };
  UrlFetchApp: { fetch(url: string, options: Record<string, unknown>): { getResponseCode(): number; getContentText(): string } };
  FormApp: { openById(id: string): { isAcceptingResponses(): boolean; setAcceptingResponses(enabled: boolean): unknown } };
  LockService: { getScriptLock(): { tryLock(ms: number): boolean; releaseLock(): void } };
  now?: () => number;
}
function fail(code: string, message: string): never { throw new AdapterError(code, message); }
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const bytes = (s: string) => encodeURIComponent(s).replace(/%[A-F0-9]{2}/g, 'x').length;
export function createNativeFormsRuntime(services: NativeFormsServices) {
  const props = services.PropertiesService.getScriptProperties(), now = services.now ?? Date.now;
  const api = (url: string, body?: unknown, method = 'post', additionalHeaders: Record<string, string> = {}) => {
    const response = services.UrlFetchApp.fetch(url, { method: body === undefined ? 'get' : method, headers: { Authorization: `Bearer ${services.ScriptApp.getOAuthToken()}`, ...additionalHeaders },
      ...(body === undefined ? {} : { contentType: 'application/json', payload: JSON.stringify(body) }), muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true });
    if (response.getResponseCode() !== 200) fail('forms_google', `Google Form operation failed (HTTP ${response.getResponseCode()}).`);
    const text = response.getContentText(); if (bytes(text) > 5_000_000) fail('forms_capacity', 'Provider response exceeds the private state bound.');
    try { return JSON.parse(text); } catch { return fail('forms_google', 'Provider returned invalid JSON.'); }
  };
  const drive = (id: string) => `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`;
  const forms = (id: string) => `https://forms.googleapis.com/v1/forms/${encodeURIComponent(id)}`;
  function file(id: string, owner: string, editors: string[] = []) {
    const f = api(`${drive(id)}?fields=id,name,mimeType,size,version,trashed,owners(emailAddress),permissions(type,role,emailAddress,deleted)`);
    if (f.id !== id || f.trashed || f.owners?.length !== 1 || f.owners[0].emailAddress !== owner
      || f.permissions?.length !== new Set([owner, ...editors]).size || f.permissions.some((p: any) => p.deleted || p.type !== 'user'
        || ![owner, ...editors].includes(p.emailAddress) || p.role !== (p.emailAddress === owner ? 'owner' : 'writer'))) fail('forms_isolation', 'Exact Form or private-state ownership and sharing did not verify.');
    return f;
  }
  function privateJson(id: string, owner: string) {
    const metadata = file(id, owner); if (metadata.mimeType !== 'application/json' || Number(metadata.size) > 5_000_000) fail('forms_state', 'Private JSON storage is invalid.');
    return { metadata, value: api(`${drive(id)}?alt=media`) };
  }
  function context() {
    const rawHost = props.getProperty(HOST_PROPERTIES.config); if (!rawHost) return undefined;
    const host = parseStagingHostConfig(JSON.parse(rawHost)), owner = services.Session.getEffectiveUser().getEmail().trim().toLowerCase();
    if (owner !== host.expectedAutomationEmail) fail('forms_identity', 'Use the configured SHAMROCK staging automation account.');
    let raw = props.getProperty(FORMS_PROPERTIES.config);
    if (!raw) { const id = props.getProperty(CONFIG_FILE_ID_PROPERTY); if (id) raw = privateJson(id, owner).value[FORMS_PROPERTIES.config]; }
    if (!raw) return undefined;
    const document = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const config = (document?.configFileId ? privateJson(document.configFileId, owner).value : document) as NativeFormsConfig;
    if (config.version !== 1 || config.environment !== 'staging' || config.generation !== host.generation || config.resourceReview !== 'EXISTING_FORMS_REVIEWED_FOR_STAGING'
      || typeof config.enabled !== 'boolean' || typeof config.intakeEnabled !== 'boolean' || !Array.isArray(config.forms) || config.forms.length !== 3
      || !Array.isArray(config.principals) || config.principals.length > 1000 || new Set(config.principals.map(p => p.email.toLowerCase())).size !== config.principals.length
      || new Set([config.stateFileId, config.intakeFileId, ...config.forms.map(f => f.formId)]).size !== 5) fail('forms_configuration', 'Reviewed isolated Form configuration is required.');
    for (const b of config.forms) if (!b.expectedTitle.includes('Staging') || b.intake.formId !== b.formId || b.intake.resourceKey !== b.resourceKey || b.intake.kind !== b.key) fail('forms_configuration', 'Native intake and publication must bind the same staging Forms.');
    const signer = createGoogleSigner(services.Utilities, props.getProperty(HOST_PROPERTIES.secret) ?? '');
    const adapter: AdapterConfig = { environment: 'staging', generation: config.generation, baseUrl: host.workerOrigin, keyId: host.keyId };
    const enabled = () => props.getProperty(FORMS_PROPERTIES.pause) !== 'true' && config.enabled;
    const intakeEnabled = () => props.getProperty(FORMS_PROPERTIES.intakePause) !== 'true' && config.intakeEnabled && props.getProperty(HOST_PROPERTIES.enabled) !== 'true';
    function request(path: string, body: unknown) {
      const payload = JSON.stringify(body), timestamp = String(Math.floor(now() / 1000));
      if (bytes(payload) > 65_536) fail('forms_capacity', 'The frozen command exceeds the bounded D1 request size.');
      const response = services.UrlFetchApp.fetch(`${adapter.baseUrl}${path}`, { method: 'post', contentType: 'application/json', payload,
        headers: { 'x-shamrock-key-id': adapter.keyId, 'x-shamrock-timestamp': timestamp, 'x-shamrock-signature': signer.hmacSha256(`POST\n${path}\n${timestamp}\n${signer.sha256(payload)}`) },
        muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true });
      let responseBody: any; try { responseBody = JSON.parse(response.getContentText()); } catch { fail('forms_transport', 'The D1 response is ambiguous; retain the same command.'); }
      return { status: response.getResponseCode(), body: responseBody };
    }
    function effect(action: string, claim?: FormsClaim) {
      const result = request(`/v1/admin/effects/${action}`, { environment: 'staging', generation: config.generation, principalId: config.principalId, workerId: config.workerId,
        ...(action === 'claim' ? { kind: 'forms.refresh' } : { effectId: claim!.effectId, claimToken: claim!.claimToken }) });
      if (result.status !== 200) fail('forms_effect', `D1 Form publication failed (HTTP ${result.status}).`); return result.body;
    }
    function storage<T>(id: string) {
      return createPrivateCheckpoint<T>({ version: () => String(file(id, owner).version),
        read: () => privateJson(id, owner).value,
        validate(value) { if (!value || typeof value !== 'object' || Array.isArray(value) || bytes(JSON.stringify(value)) > 5_000_000) fail('forms_state', 'Private Form storage is invalid or oversized.'); return value as T; },
        digest: value => signer.sha256(formsCanonical(value)),
        write(value) { api(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&fields=id,version`, value, 'patch'); },
      });
    }
    function read(binding: ManagedFormBinding): NativeFormRead {
      const response = api(forms(binding.formId));
      return { formId: response.formId, revisionId: response.revisionId, info: response.info, settings: response.settings,
        ...(response.linkedSheetId ? { linkedSheetId: response.linkedSheetId } : {}), items: response.items ?? [],
        acceptingResponses: services.FormApp.openById(binding.formId).isAcceptingResponses() };
    }
    function isolation() {
      for (const b of config.forms) { const info = file(b.formId, owner, b.allowedEditors); if (info.name !== b.expectedTitle || info.mimeType !== 'application/vnd.google-apps.form') fail('forms_isolation', 'The bound staging Form changed.'); }
      privateJson(config.stateFileId, owner); privateJson(config.intakeFileId, owner);
    }
    return { config, adapter, owner, signer, enabled, intakeEnabled, request, effect, storage, read, isolation };
  }
  function paused(key: string) { props.setProperty(key, 'true'); if (props.getProperty(key) !== 'true') fail('forms_pause', 'The local pause did not persist.'); }
  function lock<T>(operation: () => T): T { const l = services.LockService.getScriptLock(); if (!l.tryLock(25_000)) fail('forms_busy', 'Form intake is busy; replay the retained native response.'); try { return operation(); } finally { l.releaseLock(); } }
  function reviewer(ctx: NonNullable<ReturnType<typeof context>>) {
    const email = services.Session.getActiveUser().getEmail().trim().toLowerCase();
    const actor = ctx.config.principals.find(p => p.email.toLowerCase() === email);
    if (!email || !actor) fail('confirmation_required', 'An authenticated Directory manager must perform this review.');
    const result = ctx.request('/v1/admin/directory/review-authorize', { environment: 'staging', generation: ctx.config.generation, principalId: actor.principalId });
    if (result.status !== 200 || result.body.authorized !== true) fail('confirmation_required', 'Current Wing Directory authority is required.');
    return actor;
  }
  function flushIntakes(ctx: NonNullable<ReturnType<typeof context>>) {
    const store = ctx.storage<IntakeState>(ctx.config.intakeFileId), state = store.load();
    if (state.version !== 1 || state.environment !== 'staging' || state.generation !== ctx.config.generation) fail('forms_state', 'The intake journal has another generation.');
    let sent = 0;
    for (const entry of Object.values(state.entries)) for (const c of entry.commands) {
      if (c.status !== 'queued' || sent >= 10) continue;
      const response = ctx.request(c.path, c.command); sent++;
      if (response.status === 200 && response.body.commandId === c.command.commandId && response.body.status === 'committed') { c.status = 'committed'; c.receipt = response.body;
        if (c.command.operation === 'directory.enroll') {
          const email = entry.source.respondentEmail.trim().toLowerCase(), principalId = `google.${ctx.signer.sha256(email)}`, personId = response.body.result?.targetId;
          if (c.command.actor.principalId !== principalId || response.body.operation !== 'directory.enroll' || typeof personId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(personId)) fail('forms_receipt', 'Enrollment receipt identity did not verify.');
          state.enrollments ??= {}; const prior = state.enrollments[email];
          if (prior && (prior.principalId !== principalId || prior.personId !== personId)) fail('forms_receipt', 'Enrollment receipt conflicts with the retained account identity.');
          state.enrollments[email] = {principalId, personId};
          if (entry.directory) { entry.directory.personId = personId; entry.directory.baseVersion = response.body.result.version; }
        } }
      else if (response.status === 409) c.status = 'conflict';
      else if ([400, 403, 404, 422].includes(response.status)) c.status = 'rejected';
      else { store.save(state); continue; }
      entry.status = entry.commands.some(c => c.status === 'conflict') ? 'conflict' : entry.commands.some(c => c.status === 'rejected') ? 'rejected'
        : entry.commands.some(c => c.status === 'queued') ? 'queued' : entry.directory?.status === 'pending-review' ? 'pending-review' : 'committed';
      store.save(state);
    }
    return { attempted: sent };
  }
  return {
    applyControl() {
      const ctx = context(), request = ctx?.config.controlRequest;
      if (!ctx || !request) return { status: 'none' };
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(request.requestId) || !Number.isSafeInteger(request.sequence) || request.sequence < 1
        || !['setup', 'resume-publication', 'resume-intake', 'pause'].includes(request.action)
        || ![request.stateSha256, request.intakeSha256].every(h => /^[a-f0-9]{64}$/.test(h))
        || Object.keys(request).sort().join(',') !== 'action,intakeSha256,requestId,sequence,stateSha256') fail('forms_control', 'Use an exact reviewed Form control request.');
      const consume = lock(() => {
        const raw = props.getProperty(FORMS_PROPERTIES.controlReceipt);
        if (raw === formsCanonical(request)) return false;
        if (raw) { const prior = JSON.parse(raw); if (prior.sequence >= request.sequence || prior.requestId === request.requestId) fail('forms_control', 'Consumed Form requests cannot be reused.'); }
        ctx.isolation();
        if (ctx.signer.sha256(formsCanonical(ctx.storage<FormsState>(ctx.config.stateFileId).load())) !== request.stateSha256
          || ctx.signer.sha256(formsCanonical(ctx.storage<IntakeState>(ctx.config.intakeFileId).load())) !== request.intakeSha256) fail('forms_control', 'Private Form checkpoints changed after review.');
        if (request.action === 'resume-publication') paused(FORMS_PROPERTIES.pause);
        else { paused(FORMS_PROPERTIES.intakePause); if (request.action !== 'resume-intake') paused(FORMS_PROPERTIES.pause); }
        props.setProperty(FORMS_PROPERTIES.controlReceipt, formsCanonical(request));
        if (props.getProperty(FORMS_PROPERTIES.controlReceipt) !== formsCanonical(request)) fail('forms_control', 'Control consumption did not persist.');
        return true;
      });
      if (!consume) return { status: 'already-consumed' };
      // Each operation reacquires the shared lock; failure retains its pause. A new
      // reviewed sequence is required after an interrupted control operation.
      if (request.action === 'setup') return this.setup();
      if (request.action === 'resume-publication') return this.resumePublication();
      if (request.action === 'resume-intake') return this.resumeIntake();
      return this.pause();
    },
    refresh() {
      this.applyControl();
      if (props.getProperty(FORMS_PROPERTIES.pause) === 'true') return { status: 'disabled' };
      const ctx = context(); if (!ctx) return { status: 'disabled' };
      return consumeFormsRefresh({ config: ctx.adapter, enabled: ctx.enabled, intakeEnabled: ctx.intakeEnabled, now, signer: ctx.signer,
        bindings: ctx.config.forms, lock: services.LockService.getScriptLock(), assertIsolation: ctx.isolation, state: ctx.storage<FormsState>(ctx.config.stateFileId),
        effects: { claim: () => ctx.effect('claim').effect, project: claim => ctx.effect('project', claim), ack: claim => { const result = ctx.effect('ack', claim); if (result.acknowledged !== true) fail('forms_effect', 'Form acknowledgement did not verify.'); } },
        forms: { read: ctx.read, setAccepting: (b, open) => { services.FormApp.openById(b.formId).setAcceptingResponses(open); },
          write: (b, requests, requiredRevisionId) => { api(`${forms(b.formId)}:batchUpdate`, { requests, writeControl: { requiredRevisionId } }); } },
        pause: () => paused(FORMS_PROPERTIES.pause) });
    },
    pause() { let failure: unknown; for (const key of [FORMS_PROPERTIES.pause, FORMS_PROPERTIES.intakePause]) { try { paused(key); } catch (e) { failure ??= e; } }
      try { const ctx = context(); if (ctx) for (const b of ctx.config.forms) { services.FormApp.openById(b.formId).setAcceptingResponses(false); if (ctx.read(b).acceptingResponses) fail('forms_pause', 'A managed Form did not close.'); } } catch (e) { failure ??= e; }
      if (failure) throw failure; return { status: 'paused' }; },
    resumePublication() { const ctx = context(); if (!ctx || !ctx.config.enabled) fail('forms_configuration', 'Enable the reviewed private publication configuration first.');
      return lock(() => { ctx.isolation(); props.setProperty(FORMS_PROPERTIES.pause, 'false'); if (props.getProperty(FORMS_PROPERTIES.pause) !== 'false') fail('forms_pause', 'The publication gate did not persist.'); return { status: 'enabled' }; }); },
    resumeIntake() { const ctx = context(); if (!ctx || !ctx.config.intakeEnabled || props.getProperty(HOST_PROPERTIES.enabled) === 'true') fail('forms_configuration', 'Review the new intake gate and pause the original adapter before resuming.');
      return lock(() => { ctx.isolation(); const state = ctx.storage<FormsState>(ctx.config.stateFileId).load();
        const setup = JSON.parse(props.getProperty(FORMS_PROPERTIES.setup) ?? 'null');
        if (state.pending || state.claim || !setup || setup.bindings !== ctx.signer.sha256(formsCanonical(ctx.config.forms))) fail('forms_setup', 'Finish publication and verified trigger setup before resuming intake.');
        for (const b of ctx.config.forms) if (!state.current[b.key] || state.published?.[b.key] !== formReadFingerprint(ctx.read(b))) fail('forms_setup', 'Publish and verify all configured Form choices before resuming intake.');
        try {
          props.setProperty(FORMS_PROPERTIES.intakePause, 'false'); if (props.getProperty(FORMS_PROPERTIES.intakePause) !== 'false') fail('forms_pause', 'The intake gate did not persist.');
          for (const b of ctx.config.forms) { const accept = state.canAccept?.[b.key] === true; services.FormApp.openById(b.formId).setAcceptingResponses(accept); if (ctx.read(b).acceptingResponses !== accept) fail('forms_pause', 'A managed Form did not retain its intake state.'); }
        } catch (error) { paused(FORMS_PROPERTIES.intakePause); for (const b of ctx.config.forms) { try { services.FormApp.openById(b.formId).setAcceptingResponses(false); } catch {} } throw error; }
        return { status: 'intake-enabled' };
      }); },
    flush() { const ctx = context(); if (!ctx || !ctx.intakeEnabled()) return { status: 'paused' }; return lock(() => { ctx.isolation(); return flushIntakes(ctx); }); },
    setup() {
      paused(FORMS_PROPERTIES.intakePause); const ctx = context(); if (!ctx) return fail('forms_configuration', 'Managed Forms are not configured.');
      return lock(() => { ctx.isolation(); const ids: Record<string, string> = {};
        for (const b of ctx.config.forms) {
          services.FormApp.openById(b.formId).setAcceptingResponses(false);
          if (ctx.read(b).settings.emailCollectionType !== 'VERIFIED') fail('forms_identity', 'All managed Forms must collect verified Google identity.');
          const handler = MANAGED_FORM_HANDLERS[b.key], triggers = services.ScriptApp.getProjectTriggers().filter((t: any) => t.getHandlerFunction() === handler);
          for (const t of triggers) {
            if (!ids[b.key] && t.getTriggerSourceId() === b.formId && t.getEventType() === services.ScriptApp.EventType.ON_FORM_SUBMIT && t.getTriggerSource() === services.ScriptApp.TriggerSource.FORMS) ids[b.key] = t.getUniqueId();
            else services.ScriptApp.deleteTrigger(t);
          }
          if (!ids[b.key]) ids[b.key] = services.ScriptApp.newTrigger(handler).forForm(b.formId).onFormSubmit().create().getUniqueId();
        }
        props.setProperty(FORMS_PROPERTIES.setup, JSON.stringify({ bindings: ctx.signer.sha256(formsCanonical(ctx.config.forms)), ids }));
        return { status: 'ready-paused', triggers: 3 };
      });
    },
    submit(key: ManagedFormBinding['key'], event: { source: { getId(): string }; response: { getId(): string }; triggerUid: string }) {
      const ctx = context(); if (!ctx || !ctx.intakeEnabled()) return { status: 'paused' };
      return lock(() => {
        ctx.isolation(); const binding = ctx.config.forms.find(b => b.key === key); if (!binding || event.source.getId() !== binding.formId) fail('forms_identity', 'Unexpected native Form source.');
        const setup = JSON.parse(props.getProperty(FORMS_PROPERTIES.setup) ?? 'null');
        if (!setup || setup.bindings !== ctx.signer.sha256(formsCanonical(ctx.config.forms)) || setup.ids[key] !== event.triggerUid) fail('forms_setup', 'Managed Form trigger setup must be verified.');
        const metadata = ctx.read(binding); if (metadata.settings.emailCollectionType !== 'VERIFIED') fail('forms_identity', 'The Form no longer collects verified Google identity.');
        const native = api(`${forms(binding.formId)}/responses/${encodeURIComponent(event.response.getId())}`);
        if (native.responseId !== event.response.getId()) fail('forms_identity', 'Native response identity changed.');
        const answers: Record<string, string | string[]> = {};
        for (const [id, answer] of Object.entries(native.answers ?? {}) as [string, any][]) {
          if (answer.questionId !== id || !Array.isArray(answer.textAnswers?.answers)) fail('forms_answer', 'Unsupported native response answer type.');
          const values = answer.textAnswers.answers.map((a: any) => a.value); if (values.some((v: any) => typeof v !== 'string')) fail('forms_answer', 'Invalid native answer value.');
          const item = metadata.items.find(i => i.questionItem?.question?.questionId === id);
          answers[id] = item?.questionItem?.question?.choiceQuestion?.type === 'CHECKBOX' ? values : values.length === 1 ? values[0] : fail('forms_answer', 'Ambiguous scalar response.');
        }
        const source: VerifiedFormSubmission = { formId: binding.formId, responseId: native.responseId, lastSubmittedTime: native.lastSubmittedTime,
          respondentEmail: native.respondentEmail ?? '', verifiedResponder: typeof native.respondentEmail === 'string' && !!native.respondentEmail, answers };
        const id = ctx.signer.sha256(formsCanonical([binding.formId, native.responseId, native.lastSubmittedTime]));
        const store = ctx.storage<IntakeState>(ctx.config.intakeFileId), journal = store.load();
        if (journal.version !== 1 || journal.environment !== 'staging' || journal.generation !== ctx.config.generation) fail('forms_state', 'The intake journal belongs to another generation.');
        if (journal.entries[id]) {
          if (journal.entries[id].sourceHash !== ctx.signer.sha256(formsCanonical(source))) fail('forms_revision', 'A native response changed without a new revision.');
          if (journal.entries[id].status !== 'captured') return { status: journal.entries[id].status, intakeId: id };
        }
        const entry: IntakeEntry = journal.entries[id] ?? { id, source, formKey: key, sourceHash: ctx.signer.sha256(formsCanonical(source)), status: 'captured', commands: [] };
        journal.entries[id] = entry; store.save(journal); // Preserve even invalid or unenrolled submissions before interpretation.
        try {
          const catalog = ctx.storage<FormsState>(ctx.config.stateFileId).load();
          const input = { submission: source, binding: binding.intake, editions: catalog.editions, principals: [...ctx.config.principals.filter(p => p.personId || !journal.enrollments?.[p.email.toLowerCase()]), ...Object.entries(journal.enrollments ?? {}).filter(([email]) => !ctx.config.principals.some(p => p.personId && p.email.toLowerCase() === email)).map(([email, p]) => ({email, ...p}))], config: ctx.adapter, signer: ctx.signer };
          if (key === 'directory') {
            entry.directory = directoryDraftFromManagedForm(input);
            if (entry.directory.submitted.photoLink) verifyDirectoryPhoto(String(entry.directory.submitted.photoLink), (fileId, key) => api(`${drive(fileId)}?fields=id,mimeType,trashed`, undefined, 'get', key ? {'X-Goog-Drive-Resource-Keys': `${fileId}/${key}`} : {}));
            if (entry.directory.command) entry.commands.push({ command: entry.directory.command, path: '/v1/admin/commands', status: 'queued' });
            entry.status = entry.directory.status === 'pending-review' ? 'pending-review' : entry.commands.length ? 'queued' : 'committed';
          } else { entry.commands = commandsFromManagedForm(input).map(command => ({ command, path: '/v1/commands', status: 'queued' })); entry.status = 'queued'; }
        } catch (error) { entry.status = 'pending-review'; entry.issue = error instanceof AdapterError ? error.code : 'forms_review'; }
        store.save(journal); flushIntakes(ctx); return { status: store.load().entries[id].status, intakeId: id };
      });
    },
    replay(key: ManagedFormBinding['key'], responseId: string) {
      const ctx = context(); if (!ctx || !ctx.intakeEnabled()) return {status: 'paused'};
      const binding = ctx.config.forms.find(b => b.key === key), setup = JSON.parse(props.getProperty(FORMS_PROPERTIES.setup) ?? 'null');
      if (!binding || !setup?.ids?.[key]) fail('forms_setup', 'Verified managed trigger setup is required.');
      return this.submit(key, {source: {getId: () => binding.formId}, response: {getId: () => responseId}, triggerUid: setup.ids[key]});
    },
    reviewDirectory(input: { intakeId: string; reviewId: string; personId: string; expectedVersion: number; flightId: string | null; profile: DirectoryProfile }) {
      const ctx = context(); if (!ctx) fail('forms_configuration', 'Managed Forms are not configured.');
      return lock(() => {
        ctx.isolation(); const actor = reviewer(ctx);
        const store = ctx.storage<IntakeState>(ctx.config.intakeFileId), journal = store.load(), entry = journal.entries[input.intakeId];
        if (!entry || entry.formKey !== 'directory' || entry.commands.some(c => c.status === 'queued')) fail('forms_review', 'Resolve existing delivery before reviewing this Directory intake.');
        entry.directory ??= { draftId: `directory.${entry.id}`, source: entry.source, editionId: 'review-required', status: 'pending-review', submitted: {}, proposedFields: [] };
        if (input.profile.photoLink) verifyDirectoryPhoto(input.profile.photoLink, (id, key) => api(`${drive(id)}?fields=id,mimeType,trashed`, undefined, 'get', key ? {'X-Goog-Drive-Resource-Keys': `${id}/${key}`} : {}));
        const command = directoryReviewCommand({ ...input, draft: entry.directory, reviewerPrincipalId: actor.principalId, authenticatedReviewer: true,
          resourceKey: ctx.config.reviewResourceKey, config: ctx.adapter, signer: ctx.signer });
        if (entry.commands.some(c => c.command.commandId === command.commandId)) return { status: entry.status, intakeId: input.intakeId };
        entry.commands.push({ command, path: '/v1/admin/commands', status: 'queued' }); entry.directory.status = 'ready'; entry.status = 'queued'; store.save(journal);
        return flushIntakes(ctx);
      });
    },
    directoryReviewQueue() { const ctx = context(); if (!ctx) fail('forms_configuration', 'Managed Forms are not configured.');
      return lock(() => { ctx.isolation(); reviewer(ctx); const journal = ctx.storage<IntakeState>(ctx.config.intakeFileId).load();
        return Object.values(journal.entries).filter(e => e.formKey === 'directory' && e.status !== 'committed').map(clone); }); },
    status() { const ctx = context(); if (!ctx) return { status: 'disabled' }; return lock(() => { ctx.isolation(); const journal = ctx.storage<IntakeState>(ctx.config.intakeFileId).load();
      return { enabled: ctx.enabled(), intakeEnabled: ctx.intakeEnabled(), counts: Object.values(journal.entries).reduce((out, e) => { out[e.status] = (out[e.status] ?? 0) + 1; return out; }, {} as Record<string, number>) }; }); },
  };
}
