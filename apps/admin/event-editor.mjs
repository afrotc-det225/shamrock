export function eventEditorData({tables}) {
  const rows=(key,names)=>JSON.parse(tables[key]).map(values=>Object.fromEntries(names.split(" ").map((n,i)=>[n,values[i]])));
  const events=rows("events","eventId version termId eventType trainingWeek displayOrder label columnLabel expectedGroup status startAt endAt location notes hasRoster");
  const byId=new Map(events.map(e=>[e.eventId,e]));
  for(const event of events) event.eligiblePersonIds=event.hasRoster ? [] : null;
  for(const [event,person] of JSON.parse(tables.eligible)) byId.get(event).eligiblePersonIds.push(person);
  return {events,people:rows("people","personId lastName firstName asYear classYear flightId flightPathStatus"),flights:rows("flights","flightId label"),
    terms:rows("terms","termId label sortOrder isCurrent"),eventFlights:rows("eventFlights","eventId flightId")};
}

export function existingEventPayload(source, event) {
  const keys="eventId termId eventType trainingWeek displayOrder label columnLabel expectedGroup status startAt endAt location notes eligiblePersonIds".split(" ");
  const fields=Object.fromEntries(keys.map(key=>[key,event[key]]));
  return {...fields, expectedVersion:event.version, flightIds:source.eventFlights
    .filter(row => row.eventId === event.eventId).map(row => row.flightId)};
}
