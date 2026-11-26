'use strict';

const { createHash } = require('node:crypto');
const CODES = new Set(['', 'P', 'T', 'A', 'R', 'D', 'U', 'E', 'ES', 'MED', 'N/A']);
const FIXED = new Set(['last_name','first_name','as_year','flight','squadron','overall_attendance_pct','llab_attendance_pct']);
const normalize = value => String(value ?? '').trim().toLowerCase();
const code = value => typeof value === 'string' ? value.trim() : null;
const key = row => `${normalize(row.last_name)}|${normalize(row.first_name)}`;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requireInput = ok => { if (!ok) throw new Error('INVALID_RECOVERY_INPUT'); };
const time = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const letter = text => [...text].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
function range(value) {
  const match = /^'?Attendance'?!(\$?[A-Z]+)\$?(\d+)(?::(\$?[A-Z]+)\$?(\d+))?$/.exec(String(value ?? ''));
  if (!match) return null;
  const box = { r1: Number(match[2]), c1: letter(match[1].replace('$', '')), r2: Number(match[4] || match[2]), c2: letter((match[3] || match[1]).replace('$', '')) };
  return box.r1 > 0 && box.r2 >= box.r1 && box.c1 > 0 && box.c2 >= box.c1 ? box : null;
}
function cadets(value) {
  return String(value ?? '').split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const parts = s.split('=')[0].replace(/\(AS[^)]*\)/gi, '').trim().split(',').map(s => s.trim());
    return { last_name: parts[0] || '', first_name: parts[1] || '' };
  });
}

/** Pure dry run. It never returns executable writes or treats an A1 range as an identity map. */
function planAttendanceRecovery(input) {
  requireInput(input?.formatVersion === 1 && input.snapshot?.trusted === true && typeof input.snapshot.provenance === 'string' && input.snapshot.provenance.trim());
  requireInput(time(input.snapshot.capturedAt) !== null && Array.isArray(input.snapshot.headers) && Array.isArray(input.snapshot.rows));
  for (const field of ['events', 'directory', 'attendanceLog', 'audit', 'evidence']) requireInput(Array.isArray(input[field]));
  const headers = input.snapshot.headers.map(v => String(v).trim());
  requireInput(headers.includes('last_name') && headers.includes('first_name') && new Set(headers).size === headers.length);
  requireInput(input.snapshot.rows.every(row => Array.isArray(row) && row.length === headers.length));
  const entries = input.snapshot.rows.map(row => Object.fromEntries(headers.map((h, i) => [h, row[i]])));
  const activeEvents = new Map(), aliases = new Map();
  for (const row of input.events) {
    const name = String(row.display_name || row.attendance_column_label || row.event_id || '').trim();
    if (!name || /third ?hour/i.test(`${name} ${row.event_id || ''} ${row.event_type || ''}`)) continue;
    if (['canceled','cancelled','inactive','archived','n/a'].includes(normalize(row.status))) continue;
    requireInput(![row.event_id,row.display_name,row.attendance_column_label].filter(Boolean).some(v=>FIXED.has(normalize(v))));
    requireInput(!activeEvents.has(name)); activeEvents.set(name, row);
    for (const alias of [row.event_id, row.display_name, row.attendance_column_label].filter(Boolean).map(String)) {
      const previous = aliases.get(alias);
      aliases.set(alias, previous === undefined || previous === name ? name : null);
    }
  }
  const directory = new Map(), snapshotIdentities = new Map();
  for (const row of input.directory) { const k = key(row); directory.set(k, directory.has(k) ? null : row); }
  for (const row of entries) { const k = key(row); snapshotIdentities.set(k, snapshotIdentities.has(k) ? null : row); }
  const logs = input.attendanceLog;
  let previousRow = 2;
  for (const row of logs) {
    requireInput(Number.isSafeInteger(row.row) && row.row > previousRow);
    previousRow = row.row;
  }
  // Replay physical append order, exactly as the current Apps Script replayer.
  const histories = new Map(), submissions = new Map(), malformedEvents = new Set();
  for (const row of logs) {
    if (row.submission_id) submissions.set(row.submission_id, submissions.has(row.submission_id) ? null : row);
    const event = String(row.event || row.display_name || '');
    if (!activeEvents.has(event)) continue;
    const parsed = cadets(row.cadets);
    if (!parsed.length || parsed.some(p => !p.last_name || !p.first_name)) malformedEvents.add(event);
    for (const person of parsed) {
      const k = JSON.stringify([key(person), event]), history = histories.get(k) || [];
      history.push(row); histories.set(k, history);
    }
  }
  const audits = new Map(), auditMeta = [], unusableAudits = [];
  for (const row of input.audit) {
    requireInput(Number.isSafeInteger(row.row) && row.row >= 3 && !audits.has(row.row));
    audits.set(row.row, row);
    if (row.source !== 'onFrontendEdit' || row.target_sheet !== 'Attendance' || row.action !== 'edit' || row.result !== 'ok') continue;
    const box = range(row.target_range), at = time(row.timestamp);
    if (!box || at === null) { unusableAudits.push(row); continue; }
    auditMeta.push({ row, box, at, event: aliases.get(String(row.field || '')) });
  }
  const evidenceByCell = new Map(), reviewedAudits = new Set(), evidenceIssues = [];
  const seenEvidence = new Set();
  for (const item of input.evidence) {
    const meta = auditMeta.find(a => a.row.row === item.auditRow);
    const anchor = submissions.get(item.anchorSubmissionId);
    const cells = item.cells;
    const issue = reason => evidenceIssues.push({ auditRow: item.auditRow ?? null, reason });
    if (!meta || !item.provenance || item.provenance.reviewed !== true || item.provenance.kind !== 'historical-cell-map' ||
        typeof item.provenance.reference !== 'string' || !item.provenance.reference.trim() || !Array.isArray(cells) || !cells.length ||
        seenEvidence.has(item.auditRow) || cells.length !== (meta.box.r2-meta.box.r1+1)*(meta.box.c2-meta.box.c1+1)) { issue('unproven_historical_mapping'); continue; }
    seenEvidence.add(item.auditRow);
    const anchorCell = cells.find(c => c.row === meta.box.r1 && c.column === meta.box.c1);
    const anchorTime = anchor && time(anchor.submitted_at);
    const targetParts = String(meta.row.target_key || '').split(',');
    const anchorPeople = anchor ? cadets(anchor.cadets) : [];
    if (!anchorCell || !anchor || anchor.name !== 'Admin' || anchorPeople.length !== 1 || !meta.event || anchor.event !== meta.event ||
        aliases.get(anchorCell.event) !== meta.event || key(anchorPeople[0]) !== key(anchorCell) ||
        key({last_name: targetParts[0], first_name: targetParts[1]}) !== key(anchorCell) ||
        code(anchor.attendance_type) !== code(meta.row.new_value) || code(anchorCell.value) !== code(meta.row.new_value) ||
        anchorTime === null || anchorTime > meta.at || meta.at - anchorTime > 60_000) { issue('unproven_top_left_anchor'); continue; }
    const seenCells = new Set(), seenTargets = new Set(), columnEvents = new Map(), rowIdentities = new Map();
    if (cells.some(c => {
      const address = `${c.row}:${c.column}`;
      const event = aliases.get(c.event), identity = key(c), target = JSON.stringify([identity,event]);
      const invalid = !Number.isSafeInteger(c.row) || !Number.isSafeInteger(c.column) || c.row < Math.max(3, meta.box.r1) || c.row > meta.box.r2 ||
        c.column < meta.box.c1 || c.column > meta.box.c2 || !normalize(c.last_name) || !normalize(c.first_name) ||
        !event || !CODES.has(code(c.value)) || seenCells.has(address) || seenTargets.has(target) ||
        (columnEvents.has(c.column) && columnEvents.get(c.column) !== event) || (rowIdentities.has(c.row) && rowIdentities.get(c.row) !== identity);
      seenCells.add(address); seenTargets.add(target); columnEvents.set(c.column,event); rowIdentities.set(c.row,identity); return invalid;
    })) { issue('invalid_historical_cells'); continue; }
    reviewedAudits.add(item.auditRow);
    for (const cell of cells) {
      const k = JSON.stringify([key(cell), aliases.get(cell.event)]), list = evidenceByCell.get(k) || [];
      list.push({ ...cell, event: aliases.get(cell.event), meta, anchor }); evidenceByCell.set(k, list);
    }
  }
  const results = [], summary = { unchanged: 0, proposed: 0, preserved: 0, review: 0, excluded: 0, evidenceIssues: evidenceIssues.length };
  for (const person of entries) {
    for (const header of headers.filter(h => !FIXED.has(h))) {
      const restored = code(person[header]);
      if (!activeEvents.has(header)) {
        // Do not resurrect canceled events or guess how old labels map to renamed events.
        if (restored !== '') { summary.excluded++; results.push({ person: {last_name:person.last_name,first_name:person.first_name}, event:header, status:'excluded', reason:'inactive_or_stale_event' }); }
        continue;
      }
      const identity = key(person), history = histories.get(JSON.stringify([identity, header])) || [], latest = history.at(-1);
      const effective = latest ? String(latest.attendance_type ?? '').trim() : '';
      if (restored === effective) { summary.unchanged++; continue; }
      const result = { person: {last_name:person.last_name,first_name:person.first_name}, event:header, restored, effective,
        latestLogRow:latest?.row ?? null, latestSubmissionId:latest?.submission_id || null, status:'review', reason:'' };
      const decide = (status, reason) => { result.status=status; result.reason=reason; summary[status]++; results.push(result); };
      if (!normalize(person.last_name) || !normalize(person.first_name) || !directory.get(identity) || !snapshotIdentities.get(identity)) { decide('review','ambiguous_identity'); continue; }
      if (['inactive','commissioned','dropped'].includes(normalize(directory.get(identity).flight_path_status))) { decide('review','nonoperational_roster_identity'); continue; }
      if (!CODES.has(restored) || !CODES.has(effective) || malformedEvents.has(header)) { decide('review','unrecognized_code_or_log_identity'); continue; }
      const proofs = evidenceByCell.get(JSON.stringify([identity, header])) || [];
      proofs.sort((a,b) => b.meta.at-a.meta.at || b.meta.row.row-a.meta.row.row);
      const proof = proofs[0];
      if (!proof) { decide('review','missing_historical_cell_evidence'); continue; }
      result.auditRow = proof.meta.row.row;
      result.anchorSubmissionId = proof.anchor.submission_id;
      if (proofs.length > 1 && proofs[1].meta.at === proof.meta.at) { decide('review','tied_audit_times'); continue; }
      if (time(input.snapshot.capturedAt) < proof.meta.at || restored !== code(proof.value)) { decide('review','restoration_not_supported_by_evidence'); continue; }
      if (unusableAudits.some(a => !aliases.get(String(a.field || '')) || aliases.get(String(a.field || '')) === header)) { decide('review','unusable_manual_audit'); continue; }
      const laterUnmapped = auditMeta.some(a => a.at >= proof.meta.at && a.row.row !== proof.meta.row.row && !reviewedAudits.has(a.row.row) &&
        (!a.event || a.event === header || a.box.c1 !== a.box.c2));
      if (laterUnmapped) { decide('review','later_unmapped_manual_edit'); continue; }
      if (history.some(row => time(row.submitted_at) === null)) { decide('review','unknown_authority_time'); continue; }
      if (history.some(row => row.row > proof.anchor.row || time(row.submitted_at) > proof.meta.at)) { result.disposition='keep_authoritative_record'; decide('preserved','later_authoritative_record'); continue; }
      if (history.some(row => row !== proof.anchor && time(row.submitted_at) === proof.meta.at)) { decide('review','tied_authority_time'); continue; }
      // Recovered data is only a proposal, always requiring fresh dry run and approval before append.
      result.proposal = {event:header,attendance_type:restored,cadets:`${person.last_name}, ${person.first_name}`};
      result.expectedLatest = latest ? {row:latest.row,submissionId:latest.submission_id || null,sha256:sha(latest)} : null;
      decide('proposed','proven_missed_manual_cell');
    }
  }
  return { formatVersion:1, mode:'dry-run', inputSha256:sha(input), snapshotCapturedAt:input.snapshot.capturedAt,
    sourceSha256:Object.fromEntries(['snapshot','events','directory','attendanceLog','audit','evidence'].map(k=>[k,sha(input[k])])),
    attendanceHighWatermark:logs.length ? {row:logs.at(-1).row,submissionId:logs.at(-1).submission_id || null} : {row:2,submissionId:null},
    summary, results, evidenceIssues, requiresHumanReview:true, productionWrites:0,
    refreshGate:{status:summary.review || evidenceIssues.length ? 'blocked' : 'review_required', automaticRefreshPermitted:false,
      unresolvedDifferences:summary.review, unappliedProposals:summary.proposed, authoritativeDispositionsToReview:summary.preserved,
      inactiveEventExclusionsToReview:summary.excluded},
    gates:['Snapshot all current sources before repair.', 'Review every proposal and unresolved difference.',
      'Rerun against fresh ordered logs and require matching input/evidence hashes before appending approved corrections.',
      'Pause does not stop Forms or scheduled closeout; reconcile new authoritative records before any approved append.',
      'Never infer historical identities from current sorted row positions or copy all frontend differences.',
      'Append approved corrections before a non-destructive refresh; verify totals and both Form choices.'] };
}

module.exports = { planAttendanceRecovery };
