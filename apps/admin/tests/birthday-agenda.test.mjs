import test from "node:test";
import assert from "node:assert/strict";
import { birthdayAgenda, birthdayGroups, calendarWeeks } from "../src/birthday-agenda.mjs";

const rows = [
  ["Sam","B","12-30","a"], ["Lee","A","12-30","a"], ["T","C","12-31","b"],
  ["W","D","01-01","a"], ["X","E","01-02","b"], ["Y","F","01-03","a"]
];
test("the Sunday–Saturday agenda includes shared birthdays and spans New Year", () => {
  const {title, groups} = birthdayAgenda(rows, "", "2026-12-30");
  assert.equal(title, "This week");
  assert.deepEqual(groups.map(g => g.date), ["2026-12-30","2026-12-31","2027-01-01","2027-01-02"]);
  assert.deepEqual(groups[0].people.map(p => p.firstName), ["Lee","Sam"]);
  assert.deepEqual(birthdayAgenda(rows, "a", "2027-01-02").groups.map(g => g.date), ["2026-12-30","2027-01-01"]);
});
test("quiet weeks show the next four birthday dates, filtered by flight", () => {
  const {title, groups} = birthdayAgenda(rows, "", "2026-11-26");
  assert.equal(title, "Up next");
  assert.equal(groups.length, 4);
  assert.equal(groups[0].date, "2026-12-30");
  assert.deepEqual(birthdayAgenda(rows, "absent", "2026-11-26").groups, []);
  assert.deepEqual(birthdayGroups(rows, "b", "2027-01-01", "2027-01-31").map(g => g.date), ["2027-01-02"]);
});
test("leap-day birthdays follow the Directory rule and impossible dates are skipped", () => {
  const birthdays = [["A","B","02-29","a"],["C","D","02-30","a"]];
  assert.deepEqual(birthdayGroups(birthdays, "", "2026-02-01", "2026-03-31").map(g => g.date), ["2026-03-01"]);
  assert.deepEqual(birthdayGroups(birthdays, "", "2028-02-01", "2028-03-31").map(g => g.date), ["2028-02-29"]);
});

test("numbered Sunday weeks include both months and reset with the week containing January 1", () => {
  const last = calendarWeeks("2026-12").at(-1);
  assert.equal(last.number, 1);
  assert.deepEqual(last, calendarWeeks("2027-01")[0]);
  assert.deepEqual([last.days[0],last.days[6]], ["2026-12-27","2027-01-02"]);
  assert.equal(birthdayGroups(rows,"a",last.days[0],last.days[6]).length, 2);
  assert.equal(calendarWeeks("2026-11")[0].number, 45);
  assert.equal(calendarWeeks("2026-05").length, 6);
  assert.equal(calendarWeeks("2028-02").flatMap(w=>w.days).includes("2028-02-29"),true);
});
