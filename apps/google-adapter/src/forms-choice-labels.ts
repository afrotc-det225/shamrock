import { AdapterError } from './index.js';
import type { VerifiedFormSubmission } from './forms-intake.js';
import type { FormEdition } from './forms-publication.js';
import type { FormsState } from './forms-refresh.js';

export function resolvePublishedAnswers(source: VerifiedFormSubmission, windows: NonNullable<FormsState['choiceWindows']>[string] | undefined,
  load: (id: string) => FormEdition | undefined): VerifiedFormSubmission {
  if (!windows) return source;
  const submitted = Date.parse(source.lastSubmittedTime);
  const fail = (): never => { throw new AdapterError('forms_choice', 'The submitted choice could not be verified against its published question and edition.'); };
  if (!Number.isFinite(submitted)) return fail();
  const window = [...windows].reverse().find(w => w.from <= submitted);
  if (!window) return source; // Original responses carry their own references.
  const edition = load(window.editionId);
  if (!edition || edition.formId !== source.formId || edition.editionId !== window.editionId) return fail();
  const questions = new Map<string, Map<string, string>>();
  for (const [token, ref] of Object.entries(edition.references)) {
    const label = ref.label ?? window.initialLabels?.[token];
    if (!label || ref.editionId !== edition.editionId) return fail();
    const choices = questions.get(ref.questionId) ?? new Map<string, string>();
    if (choices.has(label)) return fail();
    choices.set(label, token);
    questions.set(ref.questionId, choices);
  }
  const answers = {...source.answers};
  for (const [question, value] of Object.entries(answers)) {
    const choices = questions.get(question);
    if (!choices) continue;
    const resolve = (label: string) => {
      const token = choices.get(label);
      if (!token) return fail();
      return `${label} [sr:${token}]`;
    };
    answers[question] = Array.isArray(value) ? value.map(resolve) : resolve(value);
  }
  return {...source, answers};
}
