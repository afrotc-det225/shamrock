import React, { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { toEastern } from "./time";
import { flightColors } from "./roster-colors";
import { birthdayPage } from "./birthday-agenda.mjs";

const dateLabel = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});
const weekday = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
});
export default function BirthdayAgenda({ calendar, flights, squadrons, now }) {
  const [flight, setFlight] = useState(""),
    [cursor, setCursor] = useState(null);
  const colors = new Map(
    flights.map((f) => [
      f.flightId,
      flightColors(
        f.label,
        squadrons.find((s) => s.squadronId === f.squadronId)?.label,
      )[2],
    ]),
  );
  const today = toEastern(now).slice(0, 10);
  const groups = birthdayPage(
    calendar,
    flight,
    cursor?.anchor ?? today,
    cursor?.direction ?? 1,
    !cursor,
  );
  return (
    <section className="insight birthdays" aria-labelledby="wing-birthdays">
      <header>
        <h3 id="wing-birthdays">Wing birthdays</h3>
        <select
          aria-label="Birthday flight"
          value={flight}
          onChange={(e) => {
            setFlight(e.target.value);
            setCursor(null);
          }}
        >
          <option value="">All flights</option>
          {flights.map((f) => (
            <option key={f.flightId} value={f.flightId}>
              {f.label}
            </option>
          ))}
        </select>
      </header>
      <div aria-live="polite">
        {groups.length ? (
          <ol className="birthday-list">
            {groups.map(({ date, people }) => (
              <li key={date}>
                <time dateTime={date}>
                  {dateLabel.format(new Date(date + "T00:00Z"))}
                  <small>
                    {date === today
                      ? "Today"
                      : date.slice(0, 4) !== today.slice(0, 4)
                        ? date.slice(0, 4)
                        : weekday.format(new Date(date + "T00:00Z"))}
                  </small>
                </time>
                <div>
                  {people.map((p, i) => (
                    <span
                      style={{ borderLeftColor: colors.get(p.flightId) }}
                      key={i}
                    >
                      {p.firstName} {p.lastName}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p>No birthdays recorded{flight ? " for this flight" : ""}.</p>
        )}
      </div>
      {!!groups.length && (
        <nav aria-label="Birthday dates" className="birthday-pager">
          <button
            aria-label="Previous birthdays"
            onClick={() => setCursor({ anchor: groups[0].date, direction: -1 })}
          >
            <ChevronLeft size={16} />
            Previous
          </button>
          <button disabled={!cursor} onClick={() => setCursor(null)}>
            Upcoming
          </button>
          <button
            aria-label="Next birthdays"
            onClick={() =>
              setCursor({ anchor: groups.at(-1).date, direction: 1 })
            }
          >
            Next
            <ChevronRight size={16} />
          </button>
        </nav>
      )}
    </section>
  );
}
