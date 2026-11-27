import React, {useMemo} from "react";
import People from "./People";

export default function CadetDirectory({rows, contacts}) {
  const roster = useMemo(() => {
    const flights = new Map(), squadrons = new Map();
    const people = rows.map(person => {
      const squadronId = person.squadron || null;
      const flightId = person.flight ? JSON.stringify([squadronId, person.flight]) : null;
      if (squadronId) squadrons.set(squadronId, {squadronId, label:person.squadron});
      if (flightId) flights.set(flightId, {flightId, squadronId, label:person.flight});
      return {...person, flightId};
    });
    return {people, leadership:contacts, flights:[...flights.values()], squadrons:[...squadrons.values()]};
  }, [rows, contacts]);
  return <People snapshot={roster} member readOnly leadership={!!contacts}/>;
}
