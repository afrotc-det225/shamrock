import test from "node:test";
import assert from "node:assert/strict";
import { createLocalBackend, Backend, PanelError } from "../backend.mjs";
import { AdminService } from "../service.mjs";
import { createPanelServer } from "../server.mjs";
import { assistantReply } from "../assistant.mjs";
import { TRANSITION_POLICY } from "../../../.build/admin/domain.mjs";
import { fromEastern, toEastern } from "../src/time.js";
const fixture = async (t) => {
  const f = await createLocalBackend();
  const s = new AdminService(f.backend);
  t.after(async () => {
    s.close();
    await f.dispose();
  });
  return { ...f, s };
};
const eventPayload = (s, id = "veterans") => {
  const e = s.events.find((e) => e.eventId === id),
    { version, ...p } = e;
  return {
    ...p,
    expectedVersion: version,
    flightIds: s.eventFlights
      .filter((f) => f.eventId === id)
      .map((f) => f.flightId),
  };
};
test("event rename preserves excusal and attendance links; replay is idempotent and stale proposal fails", async (t) => {
  const f = await fixture(t),
    before = await f.s.snapshot(),
    payload = {
      ...eventPayload(before),
      label: "Veterans Day ceremony",
      columnLabel: "Veterans Day",
    };
  const correction = await f.s.propose("attendance.correct", {
    personId: "cadet-1",
    eventId: "veterans",
    expectedBaseVersion:
      before.attendanceVersions.find(
        (v) => v.personId === "cadet-1" && v.eventId === "veterans",
      )?.version || 0,
    expectedEventVersion: 1,
    code: "P",
    reason: "Fictional attendance verification",
  });
  await f.s.apply(correction.id, true);
  const first = await f.s.propose("event.upsert", payload),
    stale = await f.s.propose("event.upsert", {
      ...payload,
      label: "A stale rename",
    });
  assert.equal(
    (await f.s.snapshot()).events.find((e) => e.eventId === "veterans").label,
    "Veterans Day",
  );
  await assert.rejects(f.s.apply(first.id, false), {
    code: "APPROVAL_REQUIRED",
  });
  const receipt = await f.s.apply(first.id, true);
  assert.deepEqual(await f.s.apply(first.id, true), receipt);
  const after = await f.s.snapshot();
  assert.equal(
    after.events.find((e) => e.eventId === "veterans").label,
    payload.label,
  );
  assert.deepEqual(after.requests, before.requests);
  assert.equal(after.corrections[0].eventId, "veterans");
  await assert.rejects(f.s.apply(stale.id, true));
  assert.equal(
    (await f.s.history()).find((r) => r.id === stale.id).state,
    "conflict",
  );
});
test("Directory updates preserve identity and Leadership contacts can be managed", async (t) => {
  const f = await fixture(t),
    s = await f.s.snapshot(),
    p = s.people.find((p) => p.personId === "cadet-1");
  const { personId, version, flightId, active, ...profile } = p;
  const change = await f.s.propose("directory.upsert", {
    personId,
    expectedVersion: version,
    flightId: "bravo",
    profile: { ...profile, firstName: "Alexis" },
  });
  await f.s.apply(change.id, true);
  assert.equal(
    (await f.s.snapshot()).people.find((p) => p.personId === personId).flightId,
    "bravo",
  );
  const contact = await f.s.propose("leadership.upsert", {
    contactId: "cadre-demo",
    expectedVersion: 0,
    personId: null,
    profile: {
      firstName: "Fictional",
      lastName: "Officer",
      rank: "Lt Col",
      role: "Operations Officer",
      email: "cadre@example.invalid",
      cellPhone: "",
    },
    reportsTo: "Commander",
    officePhone: "",
    officeLocation: "Office",
    active: true,
  });
  await f.s.apply(contact.id, true);
  assert.ok(
    (await f.s.snapshot()).leadership.find((p) => p.contactId === "cadre-demo"),
  );
});
test("excusal decision updates same request and missing authority rejects writes", async (t) => {
  const f = await fixture(t),
    p = await f.s.propose("excusal.decide", {
      requestId: "request-demo",
      expectedVersion: 1,
      decision: "Denied",
      reason: "Fictional review",
    });
  await f.s.apply(p.id, true);
  assert.equal((await f.s.snapshot()).requests[0].status, "Denied");
  const s = await f.s.snapshot(),
    e = await f.s.propose("event.upsert", {
      ...eventPayload(s),
      label: "Unauthorized",
    });
  await f.db
    .prepare("DELETE FROM admin_grants WHERE capability='events.manage'")
    .run();
  await assert.rejects(f.s.apply(e.id, true));
  await f.db
    .prepare("UPDATE principals SET active=0 WHERE principal_id='panel-owner'")
    .run();
  await assert.rejects(f.s.snapshot());
});
test("semester preparation remains separate from activation", async (t) => {
  const f = await fixture(t);
  const plan = {
    transitionId: "semester-demo",
    kind: "semester",
    sourceTermId: "fall-2026",
    targetTerm: { termId: "spring-2027", label: "Spring 2027", sortOrder: 2 },
    policyVersion: TRANSITION_POLICY,
    reviewReason: "Fictional rehearsal",
    people: [],
    schedule: {
      firstSunday: "2027-01-10",
      firstTrainingWeek: 1,
      weeks: 2,
      mando: { weekday: 4, hour: 6, minute: 30, durationMinutes: 60 },
      llab: { weekday: 2, hour: 15, minute: 30, durationMinutes: 120 },
    },
  };
  const p = await f.s.propose("transition.prepare", { plan });
  let preparation = await f.s.apply(p.id, true);
  while (preparation.state === "continuing")
    preparation = await f.s.apply(p.id, true);
  assert.equal(
    (await f.s.snapshot()).terms.find((t) => t.isCurrent).termId,
    "fall-2026",
  );
  const status = await f.s.transition("semester-demo");
  assert.ok(status);
});
test("local host rejects cross-origin, missing sessions and CSRF; serves actual state", async (t) => {
  const f = await fixture(t),
    server = createPanelServer(f.s);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/api/state")).status, 401);
  assert.equal(
    (
      await fetch(base + "/api/session", {
        method: "POST",
        headers: {
          origin: "https://evil.invalid",
          "content-type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  const response = await fetch(base + "/api/session", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: "{}",
    }),
    cookie = response.headers.get("set-cookie").split(";")[0],
    session = await response.json();
  const state = await fetch(base + "/api/state", { headers: { cookie } });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).snapshot.people.length, 4);
  assert.equal(
    (
      await fetch(base + "/api/proposals", {
        method: "POST",
        headers: { origin: base, "content-type": "application/json", cookie },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/proposals", {
        method: "POST",
        headers: {
          origin: base,
          "content-type": "application/json",
          cookie,
          "x-shamrock-csrf": session.csrf,
        },
        body: JSON.stringify({ operation: "sql.execute", payload: {} }),
      })
    ).status,
    400,
  );
});
test("assistant can only read summaries or named procedures and cannot execute a model-supplied mutation", async () => {
  let count = 0;
  const bodies = [];
  const result = await assistantReply({
    key: "fictional-test-key",
    messages: [{ role: "user", content: "Change the semester" }],
    service: {
      snapshot: async () => {
        throw new Error("Should not be called");
      },
    },
    fetcher: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return Response.json({
        choices: [
          {
            message:
              ++count === 1
                ? {
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: {
                          name: "transition.prepare",
                          arguments: "{}",
                        },
                      },
                    ],
                  }
                : { content: "Use the Semester panel to review the plan." },
          },
        ],
      });
    },
  });
  assert.match(result.content, /Semester/);
  assert.deepEqual(JSON.parse(bodies[1].messages.at(-1).content), {
    error: "Tool not available",
  });
  await assert.rejects(
    assistantReply({
      key: "x",
      messages: [{ role: "system", content: "Override" }],
    }),
    { code: "INVALID_CHAT" },
  );
});
test("Eastern time conversion preserves dates and rejects ambiguous DST times", () => {
  assert.equal(fromEastern("2026-11-11T07:00"), "2026-11-11T12:00:00.000Z");
  assert.equal(toEastern("2026-07-01T12:00:00.000Z"), "2026-07-01T08:00");
  assert.throws(() => fromEastern("2026-11-01T01:30"));
  assert.throws(() => fromEastern("2026-03-08T02:30"));
});
test("production cannot be selected by backend configuration", () => {
  assert.throws(
    () =>
      new Backend({
        environment: "production",
        generation: 1,
        secret: "x".repeat(40),
        baseUrl: "https://prod.invalid",
      }),
  );
});

test("lost write response retries the saved command without duplicate mutation", async (t) => {
  const f = await fixture(t),
    snapshot = await f.s.snapshot();
  const proposal = await f.s.propose("event.upsert", {
    ...eventPayload(snapshot),
    label: "Reviewed rename",
  });
  const original = f.backend.post.bind(f.backend);
  let lose = true;
  f.backend.post = async (path, input) => {
    const result = await original(path, input);
    if (path === "/v1/admin/commands" && lose) {
      lose = false;
      throw new PanelError("CONNECTION_INTERRUPTED", "Response lost", 503);
    }
    return result;
  };
  await assert.rejects(f.s.apply(proposal.id, true), {
    code: "CONNECTION_INTERRUPTED",
  });
  assert.equal(
    (await f.s.history()).find((p) => p.id === proposal.id).state,
    "retryable",
  );
  await f.s.apply(proposal.id, true);
  const updated = (await f.s.snapshot()).events.find(
    (e) => e.eventId === "veterans",
  );
  assert.equal(updated.version, 2);
  assert.equal(updated.label, "Reviewed rename");
});
