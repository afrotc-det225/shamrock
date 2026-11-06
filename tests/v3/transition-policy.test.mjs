import assert from 'node:assert/strict';
import test from 'node:test';
import {parseTransitionPlan,prepareTransition,suggestAcademicProgression} from '../../.build/v3/packages/domain/src/transitions.js';
const profile=()=>({lastName:'Example',firstName:'Cadet',asYear:'AS300',rank:'C/2d Lt',role:'Flight Commander',university:'Notre Dame',email:'cadet@example.invalid',phone:'',dorm:'',cipBroadArea:'14 - Engineering',cipCode:'14.0901',afsc:'',homeTown:'',homeState:'',classYear:'2030',dateOfBirth:'2000-01-02',flightPathStatus:'Active 3/4',photoLink:''});
const plan=()=>({transitionId:'next-term',kind:'academic-year',sourceTermId:'current',targetTerm:{termId:'next',label:'Next Fall',sortOrder:2},policyVersion:'explicit-term-review-v1',reviewReason:'Reviewed fictional roster and training schedule',people:[{personId:'person',expectedVersion:1,asYear:'AS400',rank:'C/2d Lt',role:'Flight Commander',flightId:'alpha',flightPathStatus:'Active 3/4'}],schedule:{firstSunday:'2026-08-23',firstTrainingWeek:1,weeks:2,mando:{weekday:4,hour:6,minute:30,durationMinutes:60},llab:{weekday:2,hour:15,minute:30,durationMinutes:120}}});
test('transition policy preserves inactive and AS400 records; validates calendar, explicit scope and schedule',()=>{
 const p={...profile(),personId:'person',version:1,active:true,flightId:'alpha'};
 assert.equal(suggestAcademicProgression(p).asYear,'AS400');assert.equal(suggestAcademicProgression({...p,asYear:'AS400'}).asYear,'AS400');
 assert.equal(suggestAcademicProgression({...p,asYear:'AS100',flightPathStatus:'Dropped'}).asYear,'AS100');
 for(const change of [p=>p.schedule.firstSunday='2026-02-30',p=>p.schedule.firstSunday='2026-08-24',p=>p.schedule.mando.hour=25,p=>p.people[0].flightId=null,p=>p.people.push({...p.people[0]}),p=>p.policyVersion='automatic']){const bad=plan();change(bad);assert.throws(()=>parseTransitionPlan(bad));}
 const valid=parseTransitionPlan(plan());const snapshot={people:[p],terms:[{termId:'current',label:'Current',sortOrder:1,isCurrent:true}],diagnostics:[],flights:[{flightId:'alpha',label:'Alpha',squadronId:'blue'}]};
 const result=prepareTransition(valid,snapshot);assert.equal(result.events.length,6);assert.equal(result.events[0].startAt,'2026-08-27T10:30:00.000Z');assert.equal(result.people[0].role,'Flight Commander');
 const dst=plan();dst.schedule.firstSunday='2026-11-01';dst.schedule.mando={weekday:0,hour:1,minute:30,durationMinutes:60};assert.throws(()=>prepareTransition(parseTransitionPlan(dst),snapshot),/ambiguous/);
});

