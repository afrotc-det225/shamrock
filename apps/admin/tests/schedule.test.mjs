import test from 'node:test';
import assert from 'node:assert/strict';
import {semesterDefaults,rescheduleEvent} from '../src/schedule.mjs';
test('semester defaults follow the current recurring schedule without guessing an academic start date',()=>{
  const event={termId:'fall',eventType:'mando',status:'active',trainingWeek:14,startAt:'2026-11-05T11:30:00Z',endAt:'2026-11-05T12:30:00Z'};
  const defaults=semesterDefaults({terms:[{termId:'fall',label:'Fall 2026',isCurrent:true}],events:[event]});
  assert.equal(defaults.label,'Spring 2027');assert.equal(defaults.weeks,14);
  assert.deepEqual(defaults.schedule.mando,{weekday:4,hour:6,minute:30,durationMinutes:60});
  assert.equal(defaults.firstSunday,undefined);
});
test('bulk schedule keeps the training week in Eastern time across the DST boundary',()=>{
  const event={startAt:'2026-03-05T11:30:00Z'};
  assert.deepEqual(rescheduleEvent(event,{weekday:6,hour:7,minute:0,durationMinutes:60}),{startAt:'2026-03-07T12:00:00.000Z',endAt:'2026-03-07T13:00:00.000Z'});
  assert.throws(()=>rescheduleEvent({startAt:'2026-03-12T10:30:00Z'},{weekday:0,hour:2,minute:30,durationMinutes:60}),/daylight-saving/);
});
