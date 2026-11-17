import test from 'node:test';
import assert from 'node:assert/strict';
import {READ_PROFILES,validateReadBudgets,evaluateReadBudgets} from '../../scripts/lib/panel-read-rehearsal.mjs';
const config=()=>({version:1,principalId:'fictional-owner',generation:1,limits:Object.fromEntries(READ_PROFILES.map(p=>[p,{maxRowsRead:100,maxBackendRequests:3}]))});
const samples=()=>READ_PROFILES.map(label=>({label,rowCountersAvailable:true,localRowsWritten:0,localRowsRead:100,backendRequests:3}));
test('offline read budgets require complete profile bounds and real counters without writes',()=>{
  assert.equal(validateReadBudgets(config()).generation,1);
  assert(evaluateReadBudgets(samples(),config()).every(s=>s.passed));
  for(const change of [s=>s.localRowsRead++,s=>s.backendRequests++,s=>s.rowCountersAvailable=false,s=>s.localRowsWritten=1]){const values=samples();change(values[0]);assert.equal(evaluateReadBudgets(values,config())[0].passed,false);}
  assert.throws(()=>evaluateReadBudgets(samples().slice(1),config()),/SAMPLES/);
  const missing=config();delete missing.limits.events;assert.throws(()=>validateReadBudgets(missing),/CONFIG/);
  const unbounded=config();unbounded.limits.events.maxRowsRead=Infinity;assert.throws(()=>validateReadBudgets(unbounded),/BUDGET/);
});
