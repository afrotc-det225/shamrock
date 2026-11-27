import {
  resolveCell,
  type ReportingCorrection,
  type ReportingObservation,
  type ReportingRequest,
  type ReportingLegacyBaseline,
} from "../../../packages/domain/src/frontend-reporting.js";
import { cadetAttendanceFacts } from "./frontend-transport.js";

export type ScheduledFlightEvent = {
  eventId: string;
  termId: string;
  label: string;
  startAt: string;
  endAt: string | null;
};
export function scheduledFlightEvents(
  db: D1Database,
  flight: string,
  now: string,
) {
  return db
    .prepare(
      `SELECT e.event_id AS eventId,e.label,d.term_id AS termId,d.start_at AS startAt,d.end_at AS endAt
    FROM event_units u JOIN events e USING(event_id) JOIN event_details d USING(event_id)
    WHERE u.unit_id=? AND e.active=1 AND d.status='active' AND d.term_id=(SELECT term_id FROM terms WHERE is_current=1)
      AND julianday(COALESCE(d.end_at,d.start_at))>julianday(?)
    ORDER BY julianday(d.start_at), d.display_order,e.event_id`,
    )
    .bind(flight, now);
}
export function currentFlightEvent(
  events: ScheduledFlightEvent[],
  now: string,
) {
  const started = events.filter(
    (e) => Date.parse(e.startAt) <= Date.parse(now),
  );
  const next = events.find((e) => Date.parse(e.startAt) > Date.parse(now));
  const event = started.at(-1) ?? next;
  // A shorter session can start during a week-long event.
  const boundary = [event?.endAt, next?.startAt]
    .filter((t): t is string => !!t && Date.parse(t) > Date.parse(now))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return { event, refreshAt: boundary ?? null };
}
export async function flightAttendance(
  db: D1Database,
  event: ScheduledFlightEvent,
  flight: string,
) {
  const members = db
    .prepare(
      `SELECT d.person_id AS personId,d.last_name AS lastName,d.first_name AS firstName,d.as_year AS asYear
    FROM memberships m JOIN directory_profiles d ON d.person_id=m.person_id AND d.flight_id=m.unit_id
    JOIN event_details e ON e.event_id=? WHERE m.unit_id=? AND m.active=1 AND d.flight_path_status NOT IN ('Inactive','Dropped','Commissioned')
    AND (NOT EXISTS(SELECT 1 FROM event_roster_versions v WHERE v.event_id=e.event_id AND v.version=e.version)
      OR EXISTS(SELECT 1 FROM event_roster_members r WHERE r.event_id=e.event_id AND r.version=e.version AND r.person_id=m.person_id AND r.flight_id=m.unit_id))
    ORDER BY d.last_name,d.first_name,d.person_id`,
    )
    .bind(event.eventId, flight);
  const scope = (alias: string) =>
    ` WHERE ${alias}.event_id=? AND ${alias}.person_id IN (SELECT person_id FROM memberships WHERE unit_id=? AND active=1)`;
  const fact = (alias: string, source: { select: string; from: string }) =>
    db
      .prepare("SELECT " + source.select + " " + source.from + scope(alias))
      .bind(event.eventId, flight);
  const rows = await db.batch<Record<string, unknown>>([
    members,
    fact("o", cadetAttendanceFacts.observations),
    fact("c", cadetAttendanceFacts.corrections),
    fact("b", cadetAttendanceFacts.baselines),
    db
      .prepare(
        `SELECT r.person_id AS personId,r.request_id AS requestId,r.status,
      r.requested_outcome AS requestedOutcome,COALESCE(a.audit_id,0) AS 'order' FROM excusal_records r LEFT JOIN audit_events a ON a.command_id=r.last_command_id
      ${scope("r")} AND (r.origin='native' OR (r.last_command_id IS NOT NULL AND EXISTS(SELECT 1 FROM legacy_operational_adoptions l
      WHERE l.adoption_id=r.legacy_adoption_id AND l.state='complete')))`,
      )
      .bind(event.eventId, flight),
  ]);
  return rows[0].results.map((member) => {
    const id = String(member.personId);
    const forCadet = (index: number) =>
      rows[index].results.filter((row) => row.personId === id);
    const cell = resolveCell(
      event,
      id,
      forCadet(1) as unknown as ReportingObservation[],
      forCadet(2) as unknown as ReportingCorrection[],
      forCadet(4) as unknown as ReportingRequest[],
      true,
      [],
      forCadet(3)[0] as unknown as ReportingLegacyBaseline | undefined,
    );
    return {
      ...member,
      code: cell.effectiveCode,
      needsReview: cell.needsReview,
    };
  });
}
