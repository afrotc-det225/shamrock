import React, { useState } from "react";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { toEastern } from "./time";
import { flightColors } from "./roster-colors";
import { birthdayAgenda, birthdayGroups, calendarWeeks } from "./birthday-agenda.mjs";

const monthTitle = new Intl.DateTimeFormat("en-US", {timeZone:"UTC", month:"long", year:"numeric"});
const fullDate = new Intl.DateTimeFormat("en-US", {timeZone:"UTC", dateStyle:"full"});
const shortDate = new Intl.DateTimeFormat("en-US", {timeZone:"UTC", month:"numeric", day:"numeric"});
const midnight = date => new Date(date + "T00:00Z");
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function BirthdayAgenda({calendar, flights, squadrons, now}) {
  const [flight, setFlight] = useState("");
  const [month, setMonth] = useState(null);
  const [selected, setSelected] = useState(null);
  const today = toEastern(now).slice(0, 10);
  const agenda = birthdayAgenda(calendar, flight, today);
  const initialMonth = agenda.title === "Up next" && agenda.groups.length ? agenda.groups[0].date.slice(0, 7) : today.slice(0, 7);
  const start = midnight((month || initialMonth) + "-01");
  const year = start.getUTCFullYear(), index = start.getUTCMonth();
  const showing = month || initialMonth;
  const weeks = calendarWeeks(showing);
  const groups = birthdayGroups(calendar, flight, weeks[0].days[0], weeks.at(-1).days[6]);
  const days = new Map(groups.map(g => [g.date, g]));
  const list = selected ? groups.filter(g => g.date >= selected.start && g.date <= selected.end)
    : month ? groups.filter(g => g.date.startsWith(month)) : agenda.groups;
  const listHeading = selected?.week ? "Week " + selected.week + " · " + shortDate.formatRange(midnight(selected.start), midnight(selected.end))
    : selected ? fullDate.format(midnight(selected.start)) : month ? "This month" : agenda.title;
  const inks = new Map(flights.map(f => [f.flightId, flightColors(f.label, squadrons.find(s => s.squadronId === f.squadronId)?.label)[2]]));
  const surnames = new Map();
  for (const [, surname] of calendar) surnames.set(surname, (surnames.get(surname) || 0) + 1);
  function moveMonth(offset) {
    setMonth(new Date(Date.UTC(year, index + offset, 1)).toISOString().slice(0, 7));
    setSelected(null);
  }
  function reset() { setMonth(null); setSelected(null); }
  return <section className="insight birthdays" aria-labelledby="wing-birthdays">
    <header><h3 id="wing-birthdays">Wing birthdays</h3>
      <select aria-label="Birthday flight" value={flight} onChange={e => {setFlight(e.target.value);}}>
        <option value="">All flights</option>
        {flights.map(f => <option key={f.flightId} value={f.flightId}>{f.label}</option>)}
      </select>
    </header>
    <div className="birthday-body">
      <div className="birthday-calendar">
        <div className="calendar-month">
          <strong aria-live="polite">{monthTitle.format(start)}</strong>
          <div className="calendar-tools">
            <button aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft size={16}/></button>
            <button aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight size={16}/></button>
            <button aria-label="Reset calendar" title="Reset calendar" disabled={!month && !selected} onClick={reset}><RotateCcw size={14}/></button>
          </div>
        </div>
        <div className="calendar-days">
          <abbr title="Calendar week">Wk</abbr>
          {weekdays.map(w => <abbr key={w} title={w}>{w[0]}</abbr>)}
          {weeks.map(({number,days:dates}) => {
            const first = dates[0], last = dates[6];
            const weekSelected = selected?.week === number && selected.start === first;
            return <div className="calendar-week" key={first} data-selected={weekSelected}>
              <button className="week-number" aria-pressed={weekSelected}
                aria-label={`Week ${number}, ${shortDate.formatRange(midnight(first), midnight(last))}`}
                onClick={() => { setMonth(showing); setSelected(weekSelected ? null : {start:first,end:last,week:number}); }}>{number}</button>
              {dates.map(date => {
                const day = Number(date.slice(-2)), group = days.get(date);
                const otherMonth = !date.startsWith(showing);
                const current = date === today ? "date" : undefined;
                if (!group) return <span key={date} data-outside={otherMonth} aria-current={current}>{day}</span>;
                const colors = [...new Set(group.people.map(p => inks.get(p.flightId) || "#546579"))];
                const daySelected = selected?.start === date && !selected.week;
                return <button key={date} data-outside={otherMonth} style={{"--birthday-ink":colors[0]}}
                  aria-current={current} aria-pressed={daySelected}
                  aria-label={fullDate.format(midnight(date)) + ", " + group.people.length + (group.people.length === 1 ? " birthday" : " birthdays")}
                  onClick={() => { setMonth(showing); setSelected(daySelected ? null : {start:date,end:date}); }}>
                  {day}<span className="birthday-dots" aria-hidden="true">{colors.map(c => <i key={c} style={{background:c}}/>)}</span>
                </button>;
              })}
            </div>;
          })}
        </div>
      </div>
      <div className="birthday-names" aria-live="polite">
        <h4>{listHeading}</h4>
        {list.length ? <ul>{list.flatMap(({date,people}) => people.map((p,i) => <li key={date+i}>
          <i aria-hidden="true" style={{background:inks.get(p.flightId)}}/>
          <span title={[p.firstName,p.lastName].join(" ")}>C/{surnames.get(p.lastName)>1 && p.firstName ? p.firstName[0] + ". " : ""}{p.lastName} <time dateTime={date}>({shortDate.format(midnight(date))})</time></span>
        </li>))}</ul> : <p>{selected ? (selected.week ? "No birthdays this week." : "No birthdays on this day.") : month ? "No birthdays this month." : "No birthdays recorded."}</p>}
      </div>
    </div>
  </section>;
}
