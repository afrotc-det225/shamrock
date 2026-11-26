// Private import-time evidence. The return value contains only occurrence and person IDs.
const normalized = value => String(value ?? '').trim().toLowerCase();
function phoneDigits(value) {
  const number = String(value ?? '').trim();
  if (!/^[+()\d. -]+$/.test(number)) return null;
  const digits = number.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return /^\d{10}$/.test(digits) ? digits : null;
}
export const aliasEvidence = 'current-email-surname-birthdate-phone';

export function directoryAliases(records) {
  const byEmail = new Map(), links = new Map();
  for (const row of records) {
    const email = normalized(row.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push(row);
  }
  for (const rows of byEmail.values()) {
    const anchors = rows.filter(r => r.currentPersonId);
    if (anchors.length !== 1 || new Set(rows.map(r => r.sheet)).size !== rows.length) continue;
    const anchor = anchors[0], surname = normalized(anchor.lastName), phone = phoneDigits(anchor.phone);
    if (!surname || !normalized(anchor.firstName) || !phone || !/^\d{4}-\d{2}-\d{2}$/.test(anchor.birthDate)) continue;
    if (!rows.every(r => normalized(r.lastName) === surname && r.birthDate === anchor.birthDate && phoneDigits(r.phone) === phone)) continue;
    for (const row of rows) {
      if (normalized(row.firstName) && normalized(row.firstName) !== normalized(anchor.firstName))
        links.set(row.occurrenceId, anchor.currentPersonId);
    }
  }
  return links;
}

// The old import stays immutable. Re-evaluate its saved Directory evidence when publishing semester files.
export function retainedDirectoryAliases(db, importRunId) {
  const data = db.prepare(`SELECT occurrence_id, locator_json, disposition, normalized_json, diagnostics_json
    FROM legacy_source_occurrences WHERE import_run_id=? AND source_kind='directory'`).all(importRunId);
  const records = [];
  for (const entry of data) {
    const row = JSON.parse(entry.normalized_json), loc = JSON.parse(entry.locator_json);
    if (!row?.profile) return new Map();
    records.push({occurrenceId:entry.occurrence_id, sheet:JSON.stringify([loc.resourceKey,loc.sheetId]),
      ...row.profile, birthDate:JSON.parse(entry.diagnostics_json).issues?.some(issue=>issue.endsWith(':dob')) ? null : row.profile.dateOfBirth,
      currentPersonId:entry.disposition === 'normalized' ? row.personId : null});
  }
  return directoryAliases(records);
}

export function linkArchiveRows(report, links) {
  const tuple = row => JSON.stringify(['lastName','firstName','asYear','flight','squadron'].map(k => normalized(row[k])));
  const candidates = new Map(), counts = new Map(), occupied = new Set(report.rows.map(r=>r.personId).filter(Boolean));
  for (const row of report.sourceRoster) {
    const key = tuple(row);
    candidates.set(key,candidates.has(key) ? null : row);
  }
  for (const row of report.rows) {
    const id = links.get(candidates.get(tuple(row))?.directoryOccurrenceId);
    if (id) counts.set(id,(counts.get(id) ?? 0)+1);
  }
  return report.rows.map(row=>{
    if (row.personId || !row.firstName || !row.lastName || !row.asYear || !(row.flight || row.squadron)) return row;
    const match = candidates.get(tuple(row)), id = links.get(match?.directoryOccurrenceId);
    if (!id || match.personId || counts.get(id)!==1 || occupied.has(id)) return row;
    return {...row,personId:id,identityStatus:'resolved'};
  });
}
