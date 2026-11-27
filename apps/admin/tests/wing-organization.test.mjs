import assert from "node:assert/strict";
import test from "node:test";
import {buildWingOrganization,filterWingOrganization} from "../src/wing-organization.js";

test("chart uses the reference hierarchy with current occupants and catalog flight parents",()=>{
  const person=(personId,role,extra={})=>({personId,role,rank:"C/Capt",firstName:"Sample",lastName:personId,active:true,...extra});
  const roster={squadrons:[{squadronId:"gold",label:"Gold"}],flights:[{flightId:"alpha",label:"Alpha",squadronId:"gold"}],
    people:[person("one","Cadet Wing Commander"),person("two","Mission Support Squadron Deputy Commander"),
      person("three","PA/PO - Publications & Alpha Flight Uniform Officer"),person("four","Crosstown Liaison Task Force"),
      person("five","Alpha Flight Commander"),person("gone","Alpha Deputy Flight Commander",{active:false}),
      person("six","New appointment",{flightId:"alpha"}),person("seven","",{flightId:"alpha"})],
    leadership:[{...person("one","Cadet Wing Commander"),contactId:"contact"}, {...person("gone","Alpha Deputy Flight Commander"),contactId:"old"}, {contactId:"office",role:"Commander",reportsTo:"Recorded supervisor",active:true}]};
  const {wing:root,root:detachment}=buildWingOrganization(roster);
  assert.equal(detachment.assigned[0].contactId,"office");
  assert.equal(detachment.children[0].title,"Operations Officer");
  assert.equal(detachment.children[0].children[0],root);
  assert.deepEqual(root.assigned.map(p=>p.personId),["one"]);
  assert.deepEqual(root.children.map(n=>n.id),["gmc","mss","evaluations","operations","plans"]);
  const mss=root.children[1],sq=root.children[3].children[0];
  assert.equal(mss.deputy.assigned[0].personId,"two");
  assert.equal(mss.children[0].children[1].assigned[0].personId,"three");
  assert.equal(mss.children[4].team[0].personId,"four");
  assert.equal(sq.title,"Gold Squadron");
  assert.equal(sq.children[0].assigned[0].personId,"five");
  assert.deepEqual(sq.children[0].deputy.assigned,[]);
  const flight=sq.children[0];
  assert.deepEqual(flight.team.map(p=>p.personId),["seven"]);
  assert.deepEqual(flight.children.map(n=>[n.title,n.assigned[0].personId]),[["New appointment","six"],["Uniform Officer","three"]]);
  assert.equal(filterWingOrganization(detachment,"sample seven").children[0].children[0].id,"wing");
  const search=filterWingOrganization(root,"publications");
  assert.deepEqual(search.children.map(n=>n.id),["mss","operations"]);
  assert.equal(search.children[0].children[0].children[0].id,"publications");
  assert.equal(filterWingOrganization(root,"no match"),null);
});


test("cadre supervisors can be populated after their staff, and vacancies retain their place",()=>{
  const cadre=(role,reportsTo)=>({contactId:role,role,reportsTo});
  const roster={people:[],flights:[],squadrons:[],leadership:[
    cadre("Instructor","Recruiting"),cadre("Recruiting","Operations Officer"),cadre("Commander",""),
  ]};
  const {root}=buildWingOrganization(roster);
  const ops=root.children[0];
  assert.equal(root.assigned.length,1);
  assert.equal(ops.assigned.length,0);
  assert.equal(ops.children.find(n=>n.title==="Recruiting").children[0].assigned[0].role,"Instructor");
  const circular=buildWingOrganization({...roster,leadership:[cadre("Office A","Office B"),cadre("Office B","Office A")]});
  assert.equal(circular.root.children.length,3);
});

test("linked cadets use Directory contact details even when an old appointment disagrees",()=>{
  const cadet={personId:"one",firstName:"Current",lastName:"Cadet",rank:"C/Capt",role:"",email:"directory@example.invalid",phone:"",flightId:"alpha"};
  const appointment={personId:"one",contactId:"linked",version:4,firstName:"Former",lastName:"Name",rank:"C/Maj",role:"Wing Commander",email:"old@example.invalid",cellPhone:"old cell",officePhone:"office extension",reportsTo:"Operations"};
  const cadre={contactId:"cadre",firstName:"Current",lastName:"Instructor",role:"Operations Officer",cellPhone:"staff cell"};
  const roster={people:[cadet],leadership:[appointment,cadre],flights:[{flightId:"alpha",label:"Alpha"}],squadrons:[]};
  const {records,wing}=buildWingOrganization(roster);
  const linked=records.get("one");
  for(const key of Object.keys(cadet))assert.equal(linked[key],cadet[key]);
  assert.equal(linked.cellPhone,undefined);
  assert.equal(linked.officePhone,appointment.officePhone);
  assert.equal(linked.contactVersion,4);
  assert.equal(records.get("cadre").cellPhone,cadre.cellPhone);
  assert.deepEqual(wing.assigned,[]);
});
