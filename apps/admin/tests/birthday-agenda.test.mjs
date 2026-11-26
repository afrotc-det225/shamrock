import test from "node:test";
import assert from "node:assert/strict";
import { birthdayPage } from "../src/birthday-agenda.mjs";

test("agenda groups birthdays across New Year, pages both ways and filters by flight", () => {
  const rows = [
    ["Sam", "B", "12-30", "a"],
    ["Lee", "A", "12-30", "a"],
    ["T", "C", "12-31", "b"],
    ["W", "D", "01-01", "a"],
    ["X", "E", "01-02", "b"],
    ["Y", "F", "01-03", "a"],
  ];
  const current = birthdayPage(rows, "", "2026-12-30", 1, true);
  assert.deepEqual(
    current.map((g) => g.date),
    ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"],
  );
  assert.deepEqual(
    current[0].people.map((p) => p.firstName),
    ["Lee", "Sam"],
  );
  const next = birthdayPage(rows, "", current.at(-1).date, 1);
  assert.equal(next[0].date, "2027-01-03");
  assert.deepEqual(birthdayPage(rows, "", next[0].date, -1), current);
  const flight = birthdayPage(rows, "a", "2026-12-30", 1, true);
  assert.equal(flight.length, 3);
  assert(flight.every((g) => g.people.every((p) => p.flightId === "a")));
  assert.deepEqual(birthdayPage(rows, "empty", "2026-12-30", 1, true), []);
});
test("leap-day birthdays follow the SHAMROCK Directory rule", () => {
  const rows = [["A", "B", "02-29", "a"]];
  assert.equal(
    birthdayPage(rows, "", "2026-02-28", 1, true)[0].date,
    "2026-03-01",
  );
  assert.equal(
    birthdayPage(rows, "", "2028-02-28", 1, true)[0].date,
    "2028-02-29",
  );
});
