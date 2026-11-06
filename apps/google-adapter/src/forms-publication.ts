/** Non-destructive native Form publication. All bindings and retained catalogs are private. */
import { AdapterError, type Signer } from './index.js';
import type { FrontendSnapshot, SnapshotRevision, DirectoryRecord } from '../../../packages/domain/src/admin.js';

export interface NativeFormRead {
  formId: string; revisionId: string; info: Record<string, unknown>;
  settings: { emailCollectionType: string; [key: string]: unknown };
  linkedSheetId?: string;
  items: Record<string, any>[];
  acceptingResponses: boolean;
}
export interface FormRosterFilter { flightIds?: string[]; asYears?: string[]; universities?: string[]; excludeUniversities?: string[] }
export interface FrozenFormScope { unitId: string; rosterVersion: number; coveredPersonIds: string[] }
export type FormChoiceSource = { kind: 'events'; types?: string[]; flightIds?: string[] }
  | { kind: 'flights'; flightIds?: string[] }
  | ({ kind: 'people' } & FormRosterFilter)
  | { kind: 'directory'; field: string; values: string[] }
  | { kind: 'profiles'; profiles: {key: string; label: string; filter: FormRosterFilter}[] }
  | { kind: 'categories'; categories: {key: string; label: string; types: string[]}[] };
export interface NativeChoiceBinding {
  itemId: string; questionId: string; source: FormChoiceSource;
  /** Explicit existing branch destinations keyed by stable target, not visible labels. */
  /** Reviewed unreachable empty branch, or an optional list; never permits an empty response token. */
  canBeEmpty?: boolean;
  navigationDefault?: { goToSectionId: string } | { goToAction: 'NEXT_SECTION' | 'RESTART_FORM' | 'SUBMIT_FORM' };
  navigation?: Record<string, { goToSectionId: string } | { goToAction: 'NEXT_SECTION' | 'RESTART_FORM' | 'SUBMIT_FORM' }>;
}
export interface ManagedFormBinding {
  key: 'attendance' | 'excusals' | 'directory'; formId: string; resourceKey: string;
  expectedTitle: string; linkedSheetId?: string; choices: NativeChoiceBinding[];
  attendanceProfiles?: Record<string, FormRosterFilter>;
}
export type RetainedChoice = { editionId: string; questionId: string } & (
  { kind: 'category'; key: string }
  | { kind: 'scope-group'; key: string; scopes: FrozenFormScope[] }
  | { kind: 'event'; eventId: string; expectedEventVersion: number }
  | { kind: 'scope'; unitId: string; rosterVersion: number; coveredPersonIds: string[] }
  | { kind: 'person'; personId: string }
  | { kind: 'directory'; field: string; value: string });
export interface FormEdition {
  editionId: string; formId: string; resourceKey: string; generation: number; revision: SnapshotRevision;
  references: Record<string, RetainedChoice>;
  /** Frozen Directory bases are needed to avoid refreshing expected versions behind a respondent. */
  people: DirectoryRecord[];
  attendanceScopes?: Record<string, FrozenFormScope[]>;
}
export interface NativeFormPlan {
  binding: ManagedFormBinding; expectedBefore: string; expectedAfter: NativeFormRead;
  requiredRevisionId: string; requests: Record<string, unknown>[]; edition: FormEdition; canAccept: boolean;
}
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
export const formsCanonical = (x: unknown): string => JSON.stringify(x, (_k, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const same = (a: unknown, b: unknown) => formsCanonical(a) === formsCanonical(b);
const fail = (message: string): never => { throw new AdapterError('forms_publication', message); };
function hash(signer: Signer, value: unknown): string { const result = signer.sha256(formsCanonical(value)); if (!/^[a-f0-9]{64}$/.test(result)) fail('Invalid catalog digest.'); return result; }
function semantic(read: NativeFormRead): unknown {
  const { revisionId: _revision, acceptingResponses: _open, ...content } = read;
  return content;
}
export function formReadFingerprint(read: NativeFormRead): string { return formsCanonical(semantic(read)); }
export function verifyNativeFormPlan(plan: NativeFormPlan, actual: NativeFormRead): boolean {
  return actual.acceptingResponses === false && same(semantic(actual), semantic(plan.expectedAfter));
}
function frozenScopes(snapshot: FrontendSnapshot, filter: FormRosterFilter): FrozenFormScope[] {
  return snapshot.flights.filter(f => !filter.flightIds || filter.flightIds.includes(f.flightId)).map(f => ({unitId: f.flightId, rosterVersion: f.rosterVersion,
    coveredPersonIds: snapshot.people.filter(p => p.active && p.flightId === f.flightId
      && (!filter.asYears || filter.asYears.includes(p.asYear)) && (!filter.universities || filter.universities.includes(p.university))
      && (!filter.excludeUniversities || !filter.excludeUniversities.includes(p.university))).map(p => p.personId).sort()})).filter(s => s.coveredPersonIds.length);
}
function choiceCandidates(snapshot: FrontendSnapshot, source: FormChoiceSource, key: ManagedFormBinding['key'], termId: string) {
  const choices: { label: string; key: string; reference: Omit<RetainedChoice, 'editionId' | 'questionId'> | Record<string, unknown> }[] = [];

  if (source.kind === 'events') {
    const events = snapshot.events.filter(e => e.termId === termId && e.status === 'active'
    && (!source.types || source.types.includes(e.eventType))
    && (!source.flightIds || snapshot.eventFlights.some(f => f.eventId === e.eventId && source.flightIds!.includes(f.flightId))))
    .sort((a, z) => a.displayOrder - z.displayOrder || a.eventId.localeCompare(z.eventId));
    for (const e of events) choices.push({ label: e.label, key: e.eventId, reference: { kind: 'event', eventId: e.eventId, expectedEventVersion: e.version } });
  } else if (source.kind === 'flights') {
    for (const f of snapshot.flights.filter(f => !source.flightIds || source.flightIds.includes(f.flightId))) {
    const people = snapshot.people.filter(p => p.active && p.flightId === f.flightId).map(p => p.personId).sort();
    if (people.length || key === 'directory') choices.push({ label: f.label, key: f.flightId, reference: { kind: 'scope', unitId: f.flightId, rosterVersion: f.rosterVersion, coveredPersonIds: people } });
    }
  } else if (source.kind === 'people') {
    const people = snapshot.people.filter(p => p.active && (!source.flightIds || (p.flightId !== null && source.flightIds.includes(p.flightId)))
    && (!source.asYears || source.asYears.includes(p.asYear)) && (!source.universities || source.universities.includes(p.university))
    && (!source.excludeUniversities || !source.excludeUniversities.includes(p.university)))
    .sort((a, z) => `${a.lastName}\n${a.firstName}\n${a.personId}`.localeCompare(`${z.lastName}\n${z.firstName}\n${z.personId}`));
    for (const p of people) choices.push({ label: `${p.lastName}, ${p.firstName}`, key: p.personId, reference: { kind: 'person', personId: p.personId } });
  } else if (source.kind === 'profiles') {
    for (const profile of source.profiles) choices.push({label: profile.label, key: profile.key, reference: {kind: 'scope-group', key: profile.key, scopes: frozenScopes(snapshot, profile.filter)}});
  } else if (source.kind === 'categories') {
    for (const category of source.categories) if (snapshot.events.some(e => e.termId === termId && e.status === 'active' && category.types.includes(e.eventType))) choices.push({label: category.label, key: category.key, reference: {kind: 'category', key: category.key}});
  } else {
    if (!source.field || !Array.isArray(source.values) || new Set(source.values).size !== source.values.length) fail('Directory choices require an exact reviewed catalog.');
    for (const value of source.values) choices.push({ label: value, key: value, reference: { kind: 'directory', field: source.field, value } });
  }
  return choices;
}
export function planNativeFormPublication(input: { snapshot: FrontendSnapshot; binding: ManagedFormBinding; current: NativeFormRead; signer: Signer }): NativeFormPlan {
  const { snapshot, binding, current, signer } = input;
  if (!['local', 'staging'].includes(snapshot.environment) || current.formId !== binding.formId || !current.revisionId
    || current.info.title !== binding.expectedTitle || current.linkedSheetId !== binding.linkedSheetId
    || current.settings.emailCollectionType !== 'VERIFIED' || !Array.isArray(current.items) || current.items.length > 300
    || binding.choices.length > 150 || new Set(binding.choices.map(b => b.itemId)).size !== binding.choices.length) fail('Existing verified Form bindings differ from the reviewed resource.');
  const term = snapshot.terms.filter(t => t.isCurrent); if (term.length !== 1) fail('A single current term is required.');
  const attendanceScopes = Object.fromEntries(Object.entries(binding.attendanceProfiles ?? {}).map(([key, filter]) => [key, frozenScopes(snapshot, filter)]));
  const editionId = hash(signer, { generation: snapshot.generation, binding, attendanceScopes, choices: binding.choices.map(b => choiceCandidates(snapshot, b.source, binding.key, term[0].termId)), people: binding.key === 'directory' ? snapshot.people : [] });
  const edition: FormEdition = { editionId, formId: binding.formId, resourceKey: binding.resourceKey, generation: snapshot.generation,
    revision: copy(snapshot.revision), references: {}, attendanceScopes, people: binding.key === 'directory' ? copy(snapshot.people) : [] };
  const after = copy(current); after.acceptingResponses = false;
  const requests: Record<string, unknown>[] = []; let canAccept = true;
  for (const b of binding.choices) {
    const matches = current.items.map((item, index) => ({ item, index })).filter(v => v.item.itemId === b.itemId);
    if (matches.length !== 1) fail('A bound existing question is missing or duplicated.');
    const { item, index } = matches[0], q = item.questionItem?.question;
    if (q?.questionId !== b.questionId || !['RADIO', 'DROP_DOWN', 'CHECKBOX'].includes(q?.choiceQuestion?.type)
      || q.choiceQuestion.shuffle === true || q.choiceQuestion.options?.some((o: any) => o.isOther)) fail('A bound native question has changed type or identity.');
    if (!b.navigation && !b.navigationDefault && q.choiceQuestion.options?.some((o: any) => o.goToSectionId || o.goToAction)) fail('Existing branching requires explicit stable destination bindings.');
    const choices = choiceCandidates(snapshot, b.source, binding.key, term[0].termId);
    if (choices.length > 500) fail('A native choice list exceeds the reviewed capacity.');
    const options = choices.map(({ label, key, reference }) => {
      if (!label || label.length > 500) fail('A choice label exceeds its bound.');
      const token = hash(signer, { editionId, questionId: b.questionId, reference });
      edition.references[token] = { ...reference, editionId, questionId: b.questionId } as RetainedChoice;
      const navigation = b.navigation?.[key] ?? b.navigationDefault;
      if ((b.navigation || b.navigationDefault) && !navigation) fail('A new branch requires an explicitly bound existing destination.');
      if (navigation && 'goToSectionId' in navigation && !current.items.some(i => i.itemId === navigation.goToSectionId && i.pageBreakItem)) fail('A native branch target is missing.');
      return { value: `${label} [sr:${token}]`, ...(navigation ?? {}) };
    });
    if (!options.length) { options.push({ value: 'No available choices — contact the Wing staff' }); if (q.required && !b.canBeEmpty) canAccept = false; }
    // Never rewrite/delete/move questions, response destinations, settings, images or other unowned metadata.
    const target = after.items[index]; target.questionItem.question.choiceQuestion.options = options;
    if (!same(q.choiceQuestion.options, options)) requests.push({ updateItem: { item: { itemId: b.itemId, questionItem: { question: { questionId: b.questionId, choiceQuestion: { options } } } },
      location: { index }, updateMask: 'questionItem.question.choiceQuestion.options' } });
  }
  if (formsCanonical({ requests }).length > 900_000) fail('The atomic Form update exceeds its reviewed size.');
  return { binding: copy(binding), expectedBefore: formReadFingerprint(current), expectedAfter: after,
    requiredRevisionId: current.revisionId, requests, edition, canAccept };
}

/** Old references remain immutable; capacity exhaustion stops publication instead of deleting history. */
export function retainFormEdition(editions: Record<string, FormEdition>, edition: FormEdition): Record<string, FormEdition> {
  const prior = editions[edition.editionId];
  if (prior && !same(prior, {...edition, revision: prior.revision})) fail('An existing Form edition cannot be rebound.');
  const next = { ...copy(editions), [edition.editionId]: copy(prior ?? edition) };
  if (formsCanonical(next).length > 4_000_000) fail('Retained Form catalogs need reviewed archival before another publication.');
  return next;
}
