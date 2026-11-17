import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { AS_YEAR_DISPLAY_ORDER, compareAsYearsForDisplay, compareCadetsForDisplay, compareLeadershipForDisplay } from '../../.build/v3/packages/domain/src/cadet-display-order.js';

const cadet = (personId, asYear, lastName = 'Sample', firstName = 'Cadet') => ({ personId, asYear, lastName, firstName });

test('all AS display comparisons agree with the supported Apps Script comparator', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../../dist/utils/arrays.js', import.meta.url), 'utf8'), context);
  const years = [...AS_YEAR_DISPLAY_ORDER, ' as 400 ', 'af civ', 'AS600', 'AS050', '', 'Unassigned'];
  for (const a of years) for (const b of years) assert.equal(Math.sign(compareAsYearsForDisplay(a, b)), Math.sign(context.Arrays.compareAsYearsForDisplay(a, b)));
  assert.deepEqual([...AS_YEAR_DISPLAY_ORDER].reverse().sort(compareAsYearsForDisplay), [...AS_YEAR_DISPLAY_ORDER]);
});

test('seniority precedes names, base-insensitive last names precede first names, then stable ID', () => {
  const rows = [cadet('gmc', 'AS500', 'A'), cadet('poc', 'AS300', 'Z'), cadet('junior', 'AS100', 'A'),
    cadet('b', 'AS400', 'ABLE', 'Bob'), cadet('a', 'AS400', 'able', 'Alice'),
    cadet('id-z', 'AS400', 'Equal', 'Name'), cadet('id-a', 'AS400', 'equal', 'name'),
    cadet('unknown-a', 'AS600'), cadet('unknown-b', 'AS050')];
  assert.deepEqual(rows.sort(compareCadetsForDisplay).map(row => row.personId), ['a', 'b', 'id-a', 'id-z', 'poc', 'gmc', 'junior', 'unknown-a', 'unknown-b']);
});

test('Leadership retains cadre, role and rank precedence with deterministic equal-name ties', () => {
  const leader = (contactId, rank, role, lastName = 'Sample', firstName = 'Cadet') => ({ contactId, rank, role, lastName, firstName });
  const rows = [leader('flight', 'C/Col', 'Alpha Flight Commander'), leader('wing', 'C/2d Lt', 'Wing Commander'),
    leader('cadre', 'Capt', 'Instructor'), leader('deputy', 'C/Col', 'Deputy Wing Commander'),
    leader('sq', 'C/Lt Col', 'Blue Squadron Commander'), leader('flight-junior', 'C/Maj', 'Alpha Flight Commander'),
    leader('name-b', 'C/Col', 'Bravo Flight Commander', 'Sample', 'Bob'), leader('name-a', 'C/Col', 'Bravo Flight Commander', 'sample', 'Alice'),
    leader('id-z', '', 'Other', 'Equal', 'Name'), leader('id-a', '', 'Other', 'equal', 'name')];
  assert.deepEqual(rows.sort(compareLeadershipForDisplay).map(row => row.contactId), ['cadre', 'wing', 'deputy', 'sq', 'flight', 'name-a', 'name-b', 'flight-junior', 'id-a', 'id-z']);
});
