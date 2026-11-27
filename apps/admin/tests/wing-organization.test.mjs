import assert from "node:assert/strict";
import test from "node:test";
import {buildWingOrganization,filterWingOrganization} from "../src/wing-organization.js";

test("chart uses the reference hierarchy with current occupants and catalog flight parents",()=>{
  const person=(personId,role,extra={})=>({personId,role,rank:"C/Capt",firstName:"Sample",lastName:personId,active:true,...extra});
  const roster={squadrons:[{squadronId:"gold",label:"Gold"}],flights:[{flightId:"alpha",label:"Alpha",squadronId:"gold"}],
    people:[person("one","Cadet Wing Commander"),person("two","Mission Support Squadron Deputy Commander"),
      person("three","PA/PO - Publications & Alpha Flight Uniform Officer"),person("four","Crosstown Liaison Task Force"),
      person("five","Alpha Flight Commander"),person("gone","Alpha Deputy Flight Commander",{active:false}),
      person("six","New appointment")],
    leadership:[{...person("one","Cadet Wing Commander"),contactId:"contact"}, {contactId:"office",role:"Commander",reportsTo:"Recorded supervisor",active:true}]};
  const {root,other}=buildWingOrganization(roster);
  assert.deepEqual(root.assigned.map(p=>p.personId),["one"]);
  assert.deepEqual(root.children.map(n=>n.id),["gmc","mss","evaluations","operations","plans"]);
  const mss=root.children[1],sq=root.children[3].children[0];
  assert.equal(mss.deputy.assigned[0].personId,"two");
  assert.equal(mss.children[0].children[1].assigned[0].personId,"three");
  assert.equal(mss.children[4].team[0].personId,"four");
  assert.equal(sq.title,"Gold Squadron");
  assert.equal(sq.children[0].assigned[0].personId,"five");
  assert.deepEqual(sq.children[0].deputy.assigned,[]);
  assert.deepEqual(other.map(p=>p.role),["New appointment","Commander"]);
  assert.equal(other[1].reportsTo,"Recorded supervisor");
  const search=filterWingOrganization(root,"publications");
  assert.deepEqual(search.children.map(n=>n.id),["mss"]);
  assert.equal(search.children[0].children[0].children[0].id,"publications");
  assert.equal(filterWingOrganization(root,"no match"),null);
});
