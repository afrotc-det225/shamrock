// Current queues follow the same catalog status as the native Attendance and Excusals Forms.
export function currentExcusalRequests(snapshot) {
  const term = snapshot.terms.find(t => t.isCurrent);
  if (!term) return [];
  const ids = new Set(snapshot.events.filter(e => e.termId === term.termId && e.status === 'active').map(e => e.eventId));
  return snapshot.requests.filter(r => ids.has(r.eventId));
}
