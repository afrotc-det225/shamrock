// Use UTC date arithmetic on a detachment-local calendar date; no birth years are needed.
export function birthdayPage(
  calendar,
  flight,
  anchor,
  direction,
  inclusive = false,
) {
  const groups = new Map(),
    year = Number(anchor.slice(0, 4));
  for (const [firstName, lastName, monthDay, flightId] of calendar) {
    if ((flight && flight !== flightId) || !/^\d{2}-\d{2}$/.test(monthDay))
      continue;
    for (let offset = 0; offset <= 1; offset++) {
      const source =
        String(year + direction * offset).padStart(4, "0") + "-" + monthDay;
      const time = Date.parse(source + "T00:00:00Z");
      if (!Number.isFinite(time)) continue;
      const date = new Date(time).toISOString().slice(0, 10);
      // Match the Directory display rule for leap-day birthdays.
      if (date !== source && monthDay !== "02-29") continue;
      if (
        date === anchor
          ? !inclusive
          : direction > 0
            ? date < anchor
            : date > anchor
      )
        continue;
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date).push({ firstName, lastName, flightId });
      break;
    }
  }
  const dates = [...groups.keys()].sort();
  return (direction > 0 ? dates.slice(0, 4) : dates.slice(-4)).map((date) => ({
    date,
    people: groups
      .get(date)
      .sort(
        (a, b) =>
          a.lastName.localeCompare(b.lastName) ||
          a.firstName.localeCompare(b.firstName),
      ),
  }));
}
