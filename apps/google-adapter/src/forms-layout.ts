/** Additive Attendance layout. Existing item/question identities are never replaced. */
import { AdapterError, type Signer } from './index.js';
import type { FrontendSnapshot } from '../../../packages/domain/src/admin.js';
import type { FormRosterFilter, ManagedFormBinding, NativeFormRead, NativeChoiceBinding, FormEdition } from './forms-publication.js';

export interface AttendanceRule {
  eventQuestions: string[]; scopeQuestions?: string[]; presentQuestions: string[];
  implicitProfile?: string; completeness: 'partial' | 'complete';
}
export interface AttendanceLayout {
  version: 1; review: 'OPTIONAL_UNVALIDATED_CHECKBOX_AND_SUBMIT_SECTIONS_REVIEWED';
  questionTemplateItemId: string; sectionTemplateItemId: string;
  excludedFlightLabels: string[];
  mando: { scopeQuestionId: string; eventQuestions: string[]; flights: { flightId: string; sectionId: string }[];
    crosstown: { key: string; label: string; universities: string[]; sectionId: string }[] };
  llab: { scopeQuestionId: string; eventQuestions: string[]; flights: { flightId: string; sectionId: string }[] };
  secondary: { sectionId: string; eventQuestions: string[] };
  other: { sectionId: string; eventQuestions: string[] };
}
export interface PageContinuation { action: 'CONTINUE' | 'SUBMIT' | 'RESTART' | 'GO_TO_PAGE'; targetSectionId?: string }
export interface LayoutExpansion {
  binding: ManagedFormBinding; current: NativeFormRead; requests: Record<string, unknown>[];
  continuations: string[]; rules: AttendanceRule[];
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function fail(message: string): never { throw new AdapterError('forms_layout', message); }
function matches(p: FrontendSnapshot['people'][number], filter: FormRosterFilter) {
  return p.active && (!filter.flightIds || (p.flightId !== null && filter.flightIds.includes(p.flightId)))
    && (!filter.asYears || filter.asYears.includes(p.asYear)) && (!filter.universities || filter.universities.includes(p.university))
    && (!filter.excludeUniversities || !filter.excludeUniversities.includes(p.university));
}
export function expandAttendanceLayout(snapshot: FrontendSnapshot, configured: ManagedFormBinding, original: NativeFormRead, signer: Signer, previous?: FormEdition): LayoutExpansion {
  const layout = configured.attendanceLayout;
  if (!layout || layout.version !== 1 || layout.review !== 'OPTIONAL_UNVALIDATED_CHECKBOX_AND_SUBMIT_SECTIONS_REVIEWED'
    || configured.key !== 'attendance' || !original.pageBreakNavigation) fail('A reviewed native Attendance layout and continuation readback are required.');
  const binding = clone(configured), current = clone(original), requests: Record<string, unknown>[] = [], continuations: string[] = [];
  const find = (id: string) => { const items = current.items.filter(i => i.itemId === id); if (items.length !== 1) fail('A reviewed layout anchor is missing or duplicated.'); return items[0]; };
  const template = find(layout.questionTemplateItemId), sectionTemplate = find(layout.sectionTemplateItemId);
  const tq = template.questionItem?.question;
  if (!sectionTemplate.pageBreakItem || !tq || tq.required || tq.choiceQuestion?.type !== 'CHECKBOX' || tq.choiceQuestion.shuffle
    || Object.keys(tq).some(k => !['questionId', 'required', 'choiceQuestion'].includes(k))
    || Object.keys(template.questionItem).some(k => k !== 'question')) fail('The reviewed optional checkbox/section template changed.');
  for (const item of current.items.filter(i => i.pageBreakItem)) if (!current.pageBreakNavigation![item.itemId]) fail('A native section continuation is missing.');
  if (previous) {
    if (previous.formId !== configured.formId || previous.resourceKey !== configured.resourceKey || previous.generation !== snapshot.generation) fail('The previous additive layout belongs to another binding.');
    for (const choice of previous.attendanceChoices ?? []) if (!binding.choices.some(c => c.itemId === choice.itemId)) {
      const item = find(choice.itemId);
      if (choice.source.kind !== 'people' || item.questionItem?.question?.questionId !== choice.questionId) fail('A retained cohort question changed identity.');
      binding.choices.push(clone(choice));
    }
  }
  // Retired groups remain in history but their current native choices must not retain stale cadets.
  for (const choice of binding.choices) if (choice.source.kind === 'people') choice.source = { kind: 'people', flightIds: [], asYears: choice.source.asYears };
  const reserved = new Set(current.items.flatMap(i => [i.itemId, i.questionItem?.question?.questionId].filter(Boolean)));
  const stableId = (key: string) => {
    const digest = signer.sha256(`shamrock-layout-v1\n${configured.resourceKey}\n${key}`);
    if (!/^[a-f0-9]{64}$/.test(digest)) fail('A valid layout digest is required.');
    return digest.slice(0, 7);
  };
  const add = (item: Record<string, any>, index: number) => {
    const ids = [item.itemId, item.questionItem?.question?.questionId].filter(Boolean);
    if (new Set(ids).size !== ids.length || ids.some(id => reserved.has(id))) fail('A deterministic native layout ID collided.');
    ids.forEach(id => reserved.add(id)); current.items.splice(index, 0, item);
    requests.push({ createItem: { item: clone(item), location: { index } } });
  };
  const section = (key: string, title: string, existing?: string) => {
    if (existing) { if (!find(existing).pageBreakItem) fail('A Flight branch is no longer a native section.'); return existing; }
    const id = stableId(`section:${key}`), found = current.items.find(i => i.itemId === id);
    if (found) { if (!found.pageBreakItem || found.title !== title) fail('A generated section changed or its ID collided.'); return id; }
    const item = clone(sectionTemplate); item.itemId = id; item.title = title;
    add(item, current.items.length); current.pageBreakNavigation![id] = { action: 'SUBMIT' }; continuations.push(id); return id;
  };
  const cohort = (sectionId: string, groupKey: string, groupLabel: string, branch: string | undefined, filter: FormRosterFilter) => {
    const sectionIndex = current.items.findIndex(i => i.itemId === sectionId);
    let end = current.items.findIndex((i, index) => index > sectionIndex && i.pageBreakItem); if (end < 0) end = current.items.length;
    const sectionItems = current.items.slice(sectionIndex + 1, end);
    const questions = binding.choices.filter(c => c.source.kind === 'people' && sectionItems.some(i => i.itemId === c.itemId));
    if (sectionItems.some(i => i.questionItem?.question?.choiceQuestion?.type === 'CHECKBOX' && !questions.some(q => q.itemId === i.itemId))) fail('A cohort is absent from the retained native layout; review the saved catalog before publication.');
    const years = [...new Set(snapshot.people.filter(p => matches(p, filter)).map(p => p.asYear))].sort();
    const ids: string[] = [];
    for (const q of questions) {
      const item = find(q.itemId);
      if (q.source.kind !== 'people' || q.source.asYears?.length !== 1 || item.questionItem?.question?.choiceQuestion?.type !== 'CHECKBOX') fail('An existing cohort needs one explicit AS year and native checkbox.');
      const asYear = q.source.asYears[0]; q.source = { kind: 'people', ...clone(filter), asYears: [asYear] }; ids.push(q.questionId);
    }
    for (const asYear of years) {
      if (!asYear || asYear.length > 40) fail('An AS year is outside the native layout bound.');
      const present = questions.filter(q => q.source.kind === 'people' && q.source.asYears?.[0] === asYear);
      if (present.length > 1) fail('An AS year has duplicate cohort questions.');
      if (present.length) continue;
      const itemId = stableId(`item:${groupKey}:${asYear}`), questionId = stableId(`question:${groupKey}:${asYear}`);
      const title = `Cadets (${groupLabel}) ${asYear}${branch ? ` (${branch})` : ''}`;
      const existing = current.items.find(i => i.itemId === itemId);
      if (existing) {
        if (existing.title !== title || existing.questionItem?.question?.questionId !== questionId || existing.questionItem.question.choiceQuestion?.type !== 'CHECKBOX'
          || !current.items.slice(sectionIndex + 1, end).includes(existing)) fail('A generated cohort changed or its ID collided.');
      } else {
        const item = clone(template); item.itemId = itemId; item.title = title; item.questionItem.question.questionId = questionId;
        item.questionItem.question.choiceQuestion.options = [{ value: 'No available choices — contact the Wing staff' }];
        add(item, end++);
      }
      const choice: NativeChoiceBinding = { itemId, questionId, source: { kind: 'people', ...clone(filter), asYears: [asYear] } };
      binding.choices.push(choice); ids.push(questionId);
    }
    const actual = new Set(binding.choices.filter(c => ids.includes(c.questionId)).flatMap(c => c.source.kind === 'people' ? snapshot.people.filter(p => matches(p, c.source as FormRosterFilter)).map(p => p.personId) : []));
    if (snapshot.people.filter(p => matches(p, filter)).some(p => !actual.has(p.personId))) fail('A cadet has no published cohort question.');
    return ids;
  };
  const activeFlights = snapshot.flights.filter(f => !layout.excludedFlightLabels.includes(f.label));
  const flightIds = activeFlights.map(f => f.flightId), allFlightIds = snapshot.flights.map(f => f.flightId);
  if (snapshot.people.some(p => p.active && (p.flightId === null || !allFlightIds.includes(p.flightId)))) fail('An active cadet needs a reportable Flight before publication.');
  const universities = [...new Set(layout.mando.crosstown.flatMap(c => c.universities))];
  const selector = (questionId: string) => binding.choices.find(c => c.questionId === questionId) ?? fail('A reviewed Flight selector is missing.');
  const mando = selector(layout.mando.scopeQuestionId), llab = selector(layout.llab.scopeQuestionId);
  const profiles: { key: string; label: string; filter: FormRosterFilter }[] = [];
  const mandoNavigation: NonNullable<NativeChoiceBinding['navigation']> = {}, llabNavigation: NonNullable<NativeChoiceBinding['navigation']> = {};
  const mandoQuestions: string[] = [], llabQuestions: string[] = [];
  for (const flight of activeFlights) {
    const mf = { flightIds: [flight.flightId], excludeUniversities: universities }, lf = { flightIds: [flight.flightId] };
    const mkey = `flight:${flight.flightId}`, msection = section(`mando:${flight.flightId}`, `Cadets for ${flight.label} (Mando)`, layout.mando.flights.find(f => f.flightId === flight.flightId)?.sectionId);
    const lsection = section(`llab:${flight.flightId}`, `Cadets for ${flight.label} (LLAB)`, layout.llab.flights.find(f => f.flightId === flight.flightId)?.sectionId);
    profiles.push({ key: mkey, label: flight.label, filter: mf }); mandoNavigation[mkey] = { goToSectionId: msection }; llabNavigation[flight.flightId] = { goToSectionId: lsection };
    mandoQuestions.push(...cohort(msection, `mando:${flight.flightId}`, flight.label, 'Mando', mf));
    llabQuestions.push(...cohort(lsection, `llab:${flight.flightId}`, flight.label, 'LLAB', lf));
  }
  for (const cross of layout.mando.crosstown) {
    const filter = { flightIds, universities: cross.universities };
    if (!find(cross.sectionId).pageBreakItem) fail('A crosstown branch is missing.');
    profiles.push({ key: cross.key, label: cross.label, filter }); mandoNavigation[cross.key] = { goToSectionId: cross.sectionId };
    mandoQuestions.push(...cohort(cross.sectionId, `crosstown:${cross.key}`, cross.label, 'Mando', filter));
  }
  mando.source = { kind: 'profiles', profiles }; mando.navigation = mandoNavigation;
  llab.source = { kind: 'flights', flightIds }; llab.navigation = llabNavigation;
  binding.attendanceProfiles = { ...binding.attendanceProfiles, secondary: { flightIds }, other: { flightIds: allFlightIds } };
  const secondaryQuestions = cohort(layout.secondary.sectionId, 'secondary', 'Secondary', undefined, { flightIds });
  const otherQuestions = cohort(layout.other.sectionId, 'other', 'All', undefined, { flightIds: allFlightIds });
  if (current.items.length > 300 || binding.choices.length > 250 || requests.length > 150) fail('Attendance layout growth exceeds the reviewed bounded capacity.');
  const rules: AttendanceRule[] = [
    { eventQuestions: layout.mando.eventQuestions, scopeQuestions: [layout.mando.scopeQuestionId], presentQuestions: mandoQuestions, completeness: 'partial' },
    { eventQuestions: layout.llab.eventQuestions, scopeQuestions: [layout.llab.scopeQuestionId], presentQuestions: llabQuestions, completeness: 'partial' },
    { eventQuestions: layout.secondary.eventQuestions, presentQuestions: secondaryQuestions, implicitProfile: 'secondary', completeness: 'partial' },
    { eventQuestions: layout.other.eventQuestions, presentQuestions: otherQuestions, implicitProfile: 'other', completeness: 'partial' },
  ];
  return { binding, current, requests, continuations, rules };
}
