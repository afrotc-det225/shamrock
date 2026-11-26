import { toEastern, fromEastern } from './time.js';

export function meetingDefault(events, type, fallback) {
  const candidates = events.filter(e => e.eventType === type && e.status === 'active' && e.startAt && e.endAt);
  const counts = new Map();
  for (const e of candidates) {
    const local = toEastern(e.startAt), day = new Date(local.slice(0,10) + 'T12:00:00Z');
    const [hour, minute] = local.slice(11).split(':').map(Number);
    const value = {weekday:day.getUTCDay(), hour, minute, durationMinutes:(Date.parse(e.endAt)-Date.parse(e.startAt))/60000};
    if (value.durationMinutes <= 0 || value.durationMinutes > 720) continue;
    const key = JSON.stringify(value), entry = counts.get(key) || {value, count:0};
    entry.count++; counts.set(key, entry);
  }
  return [...counts.values()].sort((a,b) => b.count-a.count)[0]?.value || fallback;
}

export function semesterDefaults(snapshot) {
  const current = snapshot.terms.find(t => t.isCurrent);
  const currentLabel = (current?.label || '').replace(/^(\d{4})-(Spring|Fall)$/i, '$2 $1');
  const match = /\b(Spring|Fall)\s+(\d{4})\b/i.exec(currentLabel);
  const label = match ? `${match[1].toLowerCase()==='fall' ? 'Spring' : 'Fall'} ${Number(match[2]) + (match[1].toLowerCase()==='fall' ? 1 : 0)}` : '';
  const events = snapshot.events.filter(e => e.termId === current?.termId);
  const weeks = Math.max(...events.map(e => e.trainingWeek || 0), 0);
  return {label, weeks: weeks > 0 && weeks <= 20 ? weeks : 15,
    schedule: {
      mando:meetingDefault(events,'mando',{weekday:4,hour:6,minute:30,durationMinutes:60}),
      llab:meetingDefault(events,'llab',{weekday:2,hour:15,minute:30,durationMinutes:120}),
    }};
}

export function rescheduleEvent(event, meeting) {
  if (!event.startAt) throw new Error('Set a date for each selected event first.');
  const local = toEastern(event.startAt), day = new Date(local.slice(0,10)+'T12:00:00Z');
  day.setUTCDate(day.getUTCDate() + Number(meeting.weekday) - day.getUTCDay());
  const startAt = fromEastern(`${day.toISOString().slice(0,10)}T${String(meeting.hour).padStart(2,'0')}:${String(meeting.minute).padStart(2,'0')}`);
  return {startAt, endAt:new Date(Date.parse(startAt)+Number(meeting.durationMinutes)*60000).toISOString()};
}
