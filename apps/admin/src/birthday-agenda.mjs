// Recurring birthdays use detachment calendar dates. UTC arithmetic keeps a day
// the same length across daylight-saving changes and never exposes a birth year.
export function birthdayGroups(calendar, flight, start, end) {
  const groups = new Map();
  for (const [firstName, lastName, monthDay, flightId] of calendar) {
    if ((flight && flight !== flightId) || !/^\d{2}-\d{2}$/.test(monthDay)) continue;
    for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year++) {
      const source = year + "-" + monthDay;
      const time = Date.parse(source + "T00:00Z");
      if (!Number.isFinite(time)) continue;
      const date = new Date(time).toISOString().slice(0, 10);
      // The Directory observes February 29 birthdays on March 1 in other years.
      if (date < start || date > end || (date !== source && monthDay !== "02-29")) continue;
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date).push({firstName, lastName, flightId});
    }
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([date, people]) => ({
    date, people: people.sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName))
  }));
}

export function birthdayAgenda(calendar, flight, today) {
  const day = new Date(today + "T00:00Z");
  const weekStart = new Date(day);
  weekStart.setUTCDate(day.getUTCDate() - day.getUTCDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
  const iso = date => date.toISOString().slice(0, 10);
  const week = birthdayGroups(calendar, flight, iso(weekStart), iso(weekEnd));
  if (week.length) return {title:"This week", groups:week};
  const nextYear = new Date(day);
  nextYear.setUTCFullYear(day.getUTCFullYear() + 1);
  nextYear.setUTCDate(nextYear.getUTCDate() - 1);
  return {title:"Up next", groups:birthdayGroups(calendar, flight, today, iso(nextYear)).slice(0, 4)};
}

// US calendar weeks begin on Sunday. The week containing January 1 is week 1.
export function calendarWeeks(month) {
  const first = new Date(month + "-01T00:00Z");
  const dayMs = 86_400_000;
  const end = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1);
  const weeks = [];
  for (let sun = first.getTime() - first.getUTCDay() * dayMs; sun < end; sun += 7 * dayMs) {
    const days = Array.from({length:7}, (_, i) => new Date(sun + i * dayMs).toISOString().slice(0, 10));
    const sat = new Date(sun + 6 * dayMs);
    const number = 1 + Math.floor((sat.getTime() - Date.UTC(sat.getUTCFullYear(), 0, 1)) / (7 * dayMs));
    weeks.push({number, days});
  }
  return weeks;
}
