import React, { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { flightColors } from "./roster-colors";
import { toEastern } from "./time";
import { birthdayAgenda, birthdayGroups, calendarWeeks } from "./birthday-agenda.mjs";

const formatter = options => new Intl.DateTimeFormat("en-US", {timeZone:"UTC", ...options});
const monthTitle = formatter({month:"long", year:"numeric"});
const shortDate = formatter({month:"short", day:"numeric"});
const weekday = formatter({weekday:"short"});
const midnight = date => new Date(date + "T00:00Z");

export default function BirthdayAgenda({calendar, flights, squadrons, now}) {
  const [flight, setFlight] = useState("");
  const [month, setMonth] = useState(null);
  const [weekStart, setWeekStart] = useState(null);
  const today = toEastern(now).slice(0, 10);
  const agenda = birthdayAgenda(calendar, flight, today);
  const defaultDate = agenda.title === "Up next" && agenda.groups.length ? agenda.groups[0].date : today;
  const showing = month || defaultDate.slice(0, 7);
  const first = midnight(showing + "-01");
  const weeks = calendarWeeks(showing);
  const groups = birthdayGroups(calendar, flight, weeks[0].days[0], weeks.at(-1).days[6]);
  const marked = new Set(groups.map(group => group.date));
  const selected = weeks.find(({days}) => weekStart ? days[0] === weekStart
    : !month && agenda.title === "This week" && days.includes(today));
  const list = selected ? groups.filter(g => selected.days.includes(g.date))
    : month ? groups.filter(g => g.date.startsWith(month)) : agenda.groups;
  const heading = weekStart && selected ? "Week " + selected.number : month ? "This month" : agenda.title;
  const flightInks = new Map(flights.map(f => [f.flightId, flightColors(f.label, squadrons.find(s => s.squadronId === f.squadronId)?.label)[2]]));
  const surnames = new Map();
  for (const [, surname] of calendar) surnames.set(surname, (surnames.get(surname) || 0) + 1);

  function moveMonth(offset) {
    setMonth(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + offset, 1)).toISOString().slice(0, 7));
    setWeekStart(null);
  }

  return <section className="insight birthdays" aria-labelledby="wing-birthdays">
    <header><h3 id="wing-birthdays">Wing birthdays</h3>
      <select aria-label="Birthday flight" value={flight} onChange={e => setFlight(e.target.value)}>
        <option value="">All flights</option>
        {flights.map(f => <option key={f.flightId} value={f.flightId}>{f.label}</option>)}
      </select>
    </header>
    <div className="birthday-body">
      <div className="birthday-calendar">
        <div className="calendar-month">
          <strong aria-live="polite">{monthTitle.format(first)}</strong>
          <div className="calendar-tools">
            <button type="button" aria-label="Reset calendar" disabled={!month} onClick={() => {setMonth(null); setWeekStart(null);}}>Reset</button>
            <button type="button" aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft size={18}/></button>
            <button type="button" aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight size={18}/></button>
          </div>
        </div>
        <div className="calendar-head" aria-hidden="true">
          {["Wk","Su","Mo","Tu","We","Th","Fr","Sa"].map(label => <span key={label}>{label}</span>)}
        </div>
        <div className="calendar-weeks">
          {weeks.map(({number,days}) => <button key={days[0]} className="calendar-week" type="button"
            aria-label={`Week ${number}, ${shortDate.formatRange(midnight(days[0]), midnight(days[6]))}`}
            aria-pressed={selected?.days[0] === days[0]} onClick={() => {setMonth(showing); setWeekStart(days[0]);}}>
            <span className="week-number">{number}</span>
            {days.map(date => <span key={date} data-outside={!date.startsWith(showing)} data-birthday={marked.has(date)}
              aria-current={date === today ? "date" : undefined}>{Number(date.slice(-2))}</span>)}
          </button>)}
        </div>
      </div>
      <section className="birthday-names" aria-live="polite">
        <h4>{heading}</h4>
        {list.length ? list.map(({date,people}) => <div className="birthday-group" key={date}>
          <time dateTime={date}>{weekday.format(midnight(date))} · {shortDate.format(midnight(date))}</time>
          <ul>{people.map((p,i) => <li key={i} style={{"--birthday-flight":flightInks.get(p.flightId)}}>C/{surnames.get(p.lastName)>1 && p.firstName ? p.firstName + " " : ""}{p.lastName}</li>)}</ul>
        </div>) : <p>{selected ? "No birthdays this week." : month ? "No birthdays this month." : "No birthdays recorded."}</p>}
      </section>
    </div>
  </section>;
}
