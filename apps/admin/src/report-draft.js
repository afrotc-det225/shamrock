// One explicitly saved report per cadet and site. Store only identifiers and versions.
export function loadReportDraft(storage, key) {
  try {
    const draft = JSON.parse(storage().getItem(key));
    if (draft && typeof draft.eventId==="string" && Array.isArray(draft.present) &&
        draft.present.every(id=>typeof id==="string") && typeof draft.roster==="string") return draft;
  } catch {}
  return null;
}

export function rosterSignature(details) {
  const members = details.reportRoster.map(row=>[row.personId,row.flightId,row.version]).sort(([a],[b])=>a.localeCompare(b));
  const flights = details.flights.map(f=>[f.flightId,f.rosterVersion]).sort(([a],[b])=>a.localeCompare(b));
  return JSON.stringify([members,flights]);
}

export function restoreSelections(draft, details) {
  const eligible = new Set(details.reportRoster.map(row=>row.personId));
  const changed = draft.roster!==rosterSignature(details);
  return {
    present:draft.present.filter(id=>eligible.has(id)),
    complete:!changed && draft.complete===true && details.ownFlightCount===eligible.size,
    changed,
  };
}
