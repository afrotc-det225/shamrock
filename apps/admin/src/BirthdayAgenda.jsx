import React, { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { toEastern } from "./time";
import { flightColors } from "./roster-colors";
import { birthdayAgenda, birthdayGroups } from "./birthday-agenda.mjs";

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
  const end = new Date(Date.UTC(year, index + 1, 0));
  const groups = birthdayGroups(calendar, flight, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
  const days = new Map(groups.map(g => [Number(g.date.slice(-2)), g]));
  const list = selected ? groups.filter(g => g.date === selected) : month ? groups : agenda.groups;
  const listHeading = selected ? fullDate.format(midnight(selected)) : month ? "This month" : agenda.title;
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
      <select aria-label="Birthday flight" value={flight} onChange={e => {setFlight(e.target.value); setSelected(null);}}>
        <option value="">All flights</option>
        {flights.map(f => <option key={f.flightId} value={f.flightId}>{f.label}</option>)}
      </select>
    </header>
    <div className="birthday-body">
      <div className="birthday-calendar">
        <div className="calendar-month">
          <button aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft size={16}/></button>
          <strong aria-live="polite">{monthTitle.format(start)}</strong>
          <button aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight size={16}/></button>
        </div>
        <div className="calendar-days">
          {weekdays.map(w => <abbr key={w} title={w}>{w[0]}</abbr>)}
          {Array.from({length:end.getUTCDate()}, (_, i) => {
            const day = i + 1, group = days.get(day);
            const style = day === 1 ? {gridColumnStart:start.getUTCDay() + 1} : undefined;
            const date = (month || initialMonth) + "-" + String(day).padStart(2,"0");
            const current = date === today ? "date" : undefined;
            if (!group) return <span key={day} style={style} aria-current={current}>{day}</span>;
            const colors = [...new Set(group.people.map(p => inks.get(p.flightId) || "#546579"))];
            return <button key={day} style={{...style,"--birthday-ink":colors[0]}} aria-current={current} aria-pressed={selected === date}
              aria-label={fullDate.format(midnight(date)) + ", " + group.people.length + (group.people.length === 1 ? " birthday" : " birthdays")}
              onClick={() => setSelected(selected === date ? null : date)}>
              {day}<span className="birthday-dots" aria-hidden="true">{colors.map(c => <i key={c} style={{background:c}}/>)}</span>
            </button>;
          })}
        </div>
      </div>
      <div className="birthday-names" aria-live="polite">
        <h4>{listHeading}</h4>
        {list.length ? <ul>{list.flatMap(({date,people}) => people.map((p,i) => <li key={date+i}>
          <i aria-hidden="true" style={{background:inks.get(p.flightId)}}/>
          <span title={[p.firstName,p.lastName].join(" ")}>C/{surnames.get(p.lastName)>1 && p.firstName ? p.firstName[0] + ". " : ""}{p.lastName} <time dateTime={date}>({shortDate.format(midnight(date))})</time></span>
        </li>))}</ul> : <p>{month ? "No birthdays this month." : "No birthdays recorded."}</p>}
        {(month || selected) && <button className="agenda-reset" onClick={reset}>Reset calendar</button>}
      </div>
    </div>
  </section>;
}
