/** Native verified-response mapping. Names, current choice labels and trigger owners are not identity. */
import { AdapterError, type AdapterConfig, type Signer } from './index.js';
import { parseCommand, type Command } from '../../../packages/domain/src/index.js';
import { DIRECTORY_SELF_FIELDS, DIRECTORY_FIELDS, parseAdminCommand, type AdminCommand, type DirectoryProfile, type DirectoryRecord } from '../../../packages/domain/src/admin.js';
import { formsCanonical, type FormEdition, type RetainedChoice, type FrozenFormScope } from './forms-publication.js';

export interface VerifiedFormSubmission {
  formId: string; responseId: string; lastSubmittedTime: string; respondentEmail: string;
  verifiedResponder: boolean; answers: Record<string, string | string[]>;
}
export interface FormPrincipal { email: string; principalId: string; personId?: string }
export interface FormIntakeBinding {
  formId: string; resourceKey: string; kind: 'attendance' | 'excusals' | 'directory';
  events?: string[]; scope?: string[]; present?: string[]; completeness?: string;
  attendanceRules?: {eventQuestions: string[]; scopeQuestions?: string[]; presentQuestions: string[]; implicitProfile?: string; completeness: 'partial' | 'complete'}[];
  outcome?: string; reason?: string; directoryFields?: Record<string, string>;
}
export interface DirectorySubmissionDraft {
  draftId: string; source: VerifiedFormSubmission; editionId: string;
  status: 'ready' | 'pending-review'; personId?: string; baseVersion?: number;
  submitted: Record<string, string | null>; proposedFields: string[];
  command?: AdminCommand;
}
function fail(code: string, message: string): never { throw new AdapterError(code, message); }
const digest = (signer: Signer, x: unknown) => { const result = signer.sha256(formsCanonical(x)); if (!/^[a-f0-9]{64}$/.test(result)) fail('forms_identity', 'Invalid native identity digest.'); return result; };
const scalar = (s: VerifiedFormSubmission, key?: string): string => { const value = key ? s.answers[key] : undefined; if (typeof value !== 'string') fail('forms_answer', 'A required native Form answer is missing.'); return value; };
function references(s: VerifiedFormSubmission, editions: Record<string, FormEdition>, fields: string[]): { edition: FormEdition; choices: { questionId: string; reference: RetainedChoice }[] } {
  const choices: { questionId: string; reference: RetainedChoice }[] = []; const used = new Set<string>();
  for (const questionId of fields) {
    const answer = s.answers[questionId]; if (answer === undefined || answer === '') continue;
    for (const label of typeof answer === 'string' ? [answer] : answer) {
      const token = /\[sr:([a-f0-9]{12})\]$/.exec(label)?.[1];
      const found = token ? Object.values(editions).filter(e => e.formId === s.formId && e.references[token]) : [];
      if (found.length !== 1) fail('forms_reference', 'A response needs its retained native choice catalog.');
      const reference = found[0].references[token!];
      if (reference.questionId !== questionId) fail('forms_reference', 'A choice was submitted to a different question.');
      used.add(reference.editionId); choices.push({ questionId, reference });
    }
  }
  if (used.size !== 1) fail('forms_reference', 'A response mixes catalog editions or has no immutable reference.');
  return { edition: editions[[...used][0]], choices };
}
function identity(s: VerifiedFormSubmission, binding: FormIntakeBinding, config: AdapterConfig, signer: Signer) {
  const timestamp = Date.parse(s.lastSubmittedTime);
  if (s.formId !== binding.formId || !s.verifiedResponder || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.respondentEmail)
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/.test(s.responseId) || !Number.isSafeInteger(timestamp) || timestamp < 1
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(s.lastSubmittedTime)
    || new Date(timestamp).toISOString().slice(0, 19) !== s.lastSubmittedTime.slice(0, 19)) fail('forms_identity', 'Verified native response identity and revision are required.');
  const key = digest(signer, [binding.resourceKey, s.responseId, s.lastSubmittedTime]);
  return { key, source: { kind: 'form' as const, resourceKey: binding.resourceKey,
    submissionId: `native.${digest(signer, [binding.resourceKey, s.responseId])}`, revision: timestamp },
    envelope: { contractVersion: 1, environment: config.environment, generation: config.generation } };
}
export function commandsFromManagedForm(input: { submission: VerifiedFormSubmission; binding: FormIntakeBinding; editions: Record<string, FormEdition>; principals: FormPrincipal[]; config: AdapterConfig; signer: Signer }): Command[] {
  const { submission: s, binding: b, editions, principals, config, signer } = input, native = identity(s, b, config, signer);
  if (b.kind === 'directory') fail('forms_binding', 'Directory submissions use the reviewable Directory intake.');
  const actor = principals.filter(p => p.email.toLowerCase() === s.respondentEmail.toLowerCase());
  if (actor.length !== 1) fail('confirmation_required', 'The verified responder requires an enrolled principal.');
  // Event questions are stable. Their retained edition selects the exact historical dynamic cohort IDs.
  const eventEdition = references(s, editions, b.events ?? []).edition;
  const attendanceRules = eventEdition.attendanceRules ?? b.attendanceRules;
  const selected = references(s, editions, [...(b.events ?? []), ...(b.scope ?? []), ...(b.present ?? []), ...(attendanceRules ?? []).flatMap(r => [...(r.scopeQuestions ?? []), ...r.presentQuestions])]);
  if (selected.edition.generation !== config.generation || selected.edition.resourceKey !== b.resourceKey) fail('forms_generation', 'This response belongs to another generation or binding.');
  const events = selected.choices.filter(c => b.events?.includes(c.questionId)).map(c => c.reference);
  if (!events.length || events.length > 25 || events.some(e => e.kind !== 'event') || new Set(events.map(e => e.kind === 'event' ? e.eventId : '')).size !== events.length) fail('forms_answer', 'Select one to twenty-five distinct bound events.');
  const envelope = { ...native.envelope, actor: { principalId: actor[0].principalId, evidence: 'google-form' }, source: native.source };
  if (b.kind === 'excusals') {
    if (!actor[0].personId) fail('confirmation_required', 'The responder needs an enrolled cadet identity.');
    return [parseCommand({ ...envelope, commandId: `form.${native.key}`, operation: 'excusal.submitMany', payload: {
      personId: actor[0].personId, requestedOutcome: scalar(s, b.outcome), reason: scalar(s, b.reason),
      events: events.map(e => { if (e.kind !== 'event') return fail('forms_answer', 'Invalid event reference.'); return { eventId: e.eventId, expectedEventVersion: e.expectedEventVersion,
        requestId: `request.${digest(signer, [native.key, e.eventId])}` }; }),
    } })];
  }
  return events.flatMap(e => {
    if (e.kind !== 'event') return fail('forms_answer', 'Invalid event reference.');
    const eventQuestion = selected.choices.find(c => c.reference === e)!.questionId;
    const matching = attendanceRules?.filter(r => r.eventQuestions.includes(eventQuestion));
    if (matching && matching.length !== 1) fail('forms_binding', 'An attendance event requires exactly one reviewed intake rule.');
    const rule = matching?.[0], scopeQuestions = rule?.scopeQuestions ?? b.scope ?? [], presentQuestions = rule?.presentQuestions ?? b.present ?? [];
    const chosen = selected.choices.filter(c => scopeQuestions.includes(c.questionId)).map(c => c.reference);
    let scopes: FrozenFormScope[];
    if (rule?.implicitProfile) {
      if (chosen.length) fail('forms_answer', 'An implicit attendance branch cannot also select a Flight.');
      scopes = selected.edition.attendanceScopes?.[rule.implicitProfile] ?? fail('forms_binding', 'The retained branch roster is missing.');
    } else {
      if (chosen.length !== 1) fail('forms_answer', 'One explicitly bound Flight or crosstown profile is required.');
      const scope = chosen[0];
      scopes = scope.kind === 'scope' ? [scope] : scope.kind === 'scope-group' ? scope.scopes : fail('forms_answer', 'Invalid attendance roster profile.');
    }
    const people = selected.choices.filter(c => presentQuestions.includes(c.questionId)).map(c => c.reference);
    if (people.some(p => p.kind !== 'person')) fail('forms_answer', 'A presence answer is not a cadet reference.');
    const present = [...new Set(people.map(p => p.kind === 'person' ? p.personId : ''))];
    if (present.some(id => scopes.filter(s => s.coveredPersonIds.includes(id)).length !== 1)) fail('forms_answer', 'A selected cadet is outside the retained branch roster.');
    if (!scopes.length) fail('forms_answer', 'The retained branch has no reportable Flight roster.');
    return scopes.map(scope => {
      const child = digest(signer, [native.key, e.eventId, scope.unitId]);
      return parseCommand({ ...envelope, commandId: `form.${child}`, source: { ...native.source, submissionId: `child.${digest(signer, [b.resourceKey, s.responseId, e.eventId, scope.unitId])}` }, operation: 'attendance.report', payload: {
        reportId: `report.${child}`, eventId: e.eventId, expectedEventVersion: e.expectedEventVersion, unitId: scope.unitId,
        rosterVersion: scope.rosterVersion, coveredPersonIds: scope.coveredPersonIds, presentPersonIds: present.filter(id => scope.coveredPersonIds.includes(id)), completeness: rule?.completeness ?? scalar(s, b.completeness),
      } });
    });
  });
}

export function directoryDraftFromManagedForm(input: { submission: VerifiedFormSubmission; binding: FormIntakeBinding; editions: Record<string, FormEdition>; principals: FormPrincipal[]; config: AdapterConfig; signer: Signer }): DirectorySubmissionDraft {
  const { submission: s, binding: b, editions, principals, config, signer } = input, native = identity(s, b, config, signer);
  if (b.kind !== 'directory' || !b.directoryFields) fail('forms_binding', 'The Directory field bindings are missing.');
  const fields = b.directoryFields;
  const choiceFields = Object.values(fields).filter(q => { const answer = s.answers[q]; return typeof answer === 'string' && /\[sr:/.test(answer); });
  const selected = references(s, editions, choiceFields);
  if (selected.edition.generation !== config.generation || selected.edition.resourceKey !== b.resourceKey) fail('forms_generation', 'The Directory edition belongs to another generation or binding.');
  const submitted: Record<string, string | null> = {};
  for (const [field, question] of Object.entries(fields)) {
    const raw = s.answers[question]; if (raw === undefined) continue;
    if (typeof raw !== 'string') fail('forms_answer', 'Directory fields must have one answer.');
    const ref = selected.choices.find(c => c.questionId === question)?.reference;
    let value = raw.trim();
    if (ref) {
      if (ref.kind === 'directory' && ref.field === field) value = ref.value;
      else if (ref.kind === 'scope' && field === 'flightId') value = ref.unitId;
      else fail('forms_reference', 'A Directory field has a different catalog binding.');
    }
    if (field === 'dateOfBirth') {
      const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
      if (match) value = `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
    }
    submitted[field] = field === 'dateOfBirth' && !value ? null : value;
  }
  // The typed email question never establishes identity and cannot overwrite account identity.
  delete submitted.email;
  delete submitted.squadron; // D1 derives Squadron from the bound Flight hierarchy.
  const actor = principals.filter(p => p.email.toLowerCase() === s.respondentEmail.toLowerCase());
  const person = actor.length === 1 && actor[0].personId ? selected.edition.people.find(p => p.personId === actor[0].personId) : undefined;
  const changed = Object.keys(submitted).filter(k => !person || submitted[k] !== (person as unknown as Record<string, unknown>)[k]);
  const proposedFields = changed.filter(k => !(DIRECTORY_SELF_FIELDS as readonly string[]).includes(k));
  const draft: DirectorySubmissionDraft = { draftId: `directory.${native.key}`, source: JSON.parse(JSON.stringify(s)), editionId: selected.edition.editionId,
    status: !person || proposedFields.length ? 'pending-review' : 'ready', submitted, proposedFields,
    ...(person ? { personId: person.personId, baseVersion: person.version } : {}) };
  if (!person) {
    // Activation is the reviewed detachment policy. Only catalog-bound initial Flight/AS year
    // and verified Google email establish the new record; titles never grant authority.
    const flight = selected.choices.find(c => c.reference.kind === 'scope' && fields.flightId === c.questionId)?.reference;
    const year = selected.choices.find(c => c.reference.kind === 'directory' && c.reference.field === 'asYear' && fields.asYear === c.questionId)?.reference;
    if (flight?.kind === 'scope' && year?.kind === 'directory' && submitted.firstName && submitted.lastName) {
      const email = s.respondentEmail.trim().toLowerCase(), principalId = `google.${signer.sha256(email)}`;
      if (!/^google\.[a-f0-9]{64}$/.test(principalId)) fail('forms_identity', 'Invalid verified account digest.');
      const profile = Object.fromEntries(DIRECTORY_FIELDS.map(field => [field, field === 'dateOfBirth' ? submitted[field] ?? null : submitted[field] ?? '']));
      Object.assign(profile, {email, asYear: year.value, rank: 'C/AB', role: '', flightPathStatus: 'Active 3/4'});
      draft.command = parseAdminCommand({ ...native.envelope, commandId: `enroll.${native.key}`,
        actor: {principalId, evidence: 'google-form'}, source: native.source, operation: 'directory.enroll',
        payload: {verifiedEmail: email, flightId: flight.unitId, profile} });
      draft.proposedFields = changed.filter(k => ![...DIRECTORY_SELF_FIELDS, 'asYear', 'flightId'].includes(k)
        && submitted[k] !== profile[k]);
      draft.status = draft.proposedFields.length ? 'pending-review' : 'ready';
    }
  }
  const changes = Object.fromEntries(changed.filter(k => (DIRECTORY_SELF_FIELDS as readonly string[]).includes(k)).map(k => [k, submitted[k]]));
  if (person && Object.keys(changes).length) draft.command = parseAdminCommand({ ...native.envelope, commandId: `self.${native.key}`,
    actor: { principalId: actor[0].principalId, evidence: 'google-form' }, source: native.source, operation: 'directory.selfUpdate',
    payload: { personId: person.personId, expectedVersion: person.version, changes } });
  return draft;
}

/** A reviewer supplies a fully reviewed profile/base; never merge a stale proposal silently. */
export function directoryReviewCommand(input: { draft: DirectorySubmissionDraft; reviewerPrincipalId: string; authenticatedReviewer: boolean;
  reviewId: string; resourceKey: string; personId: string; expectedVersion: number; flightId: string | null; profile: DirectoryProfile;
  config: AdapterConfig; signer: Signer }): AdminCommand {
  if (!input.authenticatedReviewer || !input.draft.source.verifiedResponder) fail('confirmation_required', 'An authenticated Directory manager must review this submission.');
  return parseAdminCommand({ commandId: `review.${digest(input.signer, [input.draft.draftId, input.reviewId])}`, contractVersion: 1,
    environment: input.config.environment, generation: input.config.generation, actor: { principalId: input.reviewerPrincipalId, evidence: 'authenticated-confirmation' },
    source: { kind: 'sheet', resourceKey: input.resourceKey, submissionId: input.draft.draftId, revision: 1 }, operation: 'directory.upsert',
    payload: { personId: input.personId, expectedVersion: input.expectedVersion, flightId: input.flightId, profile: input.profile } });
}

/** Check the actual Drive resource without changing its sharing. Keep its original access-bearing URI private. */
export function verifyDirectoryPhoto(uri: string, inspect: (fileId: string, resourceKey?: string) => { id: string; mimeType: string; trashed?: boolean }): string {
  if (!uri) return '';
  const match = /^https:\/\/drive\.google\.com(\/[^#\s]*)$/.exec(uri);
  if (!match) fail('photo_review', 'A private Google Drive photo file is required.');
  const fileId = /^\/file\/d\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(match[1])?.[1]
    ?? (/^\/open\?/.test(match[1]) ? /[?&]id=([A-Za-z0-9_-]+)(?:&|$)/.exec(match[1])?.[1] : undefined);
  if (!fileId) fail('photo_review', 'The photo file identity is missing.');
  const resourceKeys = [...match[1].matchAll(/[?&]resourcekey=([^&#]*)/gi)].map(m => m[1]);
  if (resourceKeys.length > 1 || (resourceKeys.length && !/^[A-Za-z0-9_-]+$/.test(resourceKeys[0]))) fail('photo_review', 'The photo resource key is invalid.');
  const file = inspect(fileId, resourceKeys[0]); if (file.id !== fileId || file.trashed || !file.mimeType.startsWith('image/')) fail('photo_review', 'The bound Drive photo is unavailable or is not an image.');
  return uri;
}
