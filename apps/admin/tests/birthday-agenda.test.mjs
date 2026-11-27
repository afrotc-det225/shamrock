import test from "node:test";
import assert from "node:assert/strict";
import { birthdayAgenda, birthdayGroups } from "../src/birthday-agenda.mjs";

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
