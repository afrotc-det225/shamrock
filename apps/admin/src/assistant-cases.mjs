const old = {eventId:"previous"}, active = {eventId:"live"}, canceled = {eventId:"canceled"};
export const regressionCases = {
  "Sunday closeout": [
    {name:"Eligible blank becomes absent",args:[{cell:{eligible:true,effectiveCode:null},latestAttendanceOrder:0,requests:[]}],expected:"A"},
    {name:"Present is preserved",args:[{cell:{eligible:true,effectiveCode:"P"},latestAttendanceOrder:0,requests:[]}],expected:null},
    {name:"Denied becomes unexcused",args:[{cell:{eligible:true,effectiveCode:"D"},latestAttendanceOrder:0,requests:[]}],expected:"U"},
  ],
  "Cadet sorting": [
    {name:"Senior sorts before junior",args:[{asYear:"AS400"},{asYear:"AS300"}],expected:-1},
    {name:"Identical entries compare equally",args:Array(2).fill({asYear:"AS100",lastName:"Test",firstName:"One",personId:"fixture"}),expected:0},
  ],
  "Excusal queue": [
    {name:"Only active events in the current term", args:[{
      terms:[{termId:"now",isCurrent:true}], events:[
        {termId:"now",eventId:"live",status:"active"},{termId:"now",eventId:"canceled",status:"canceled"},
        {termId:"past",eventId:"previous",status:"active"}],requests:[old,canceled,active]}],expected:[active]},
    {name:"No current term",args:[{terms:[],events:[],requests:[active]}],expected:[]},
  ],
  "Birthday agenda": [
    {name:"Empty flight",args:[[["A","B","02-29","alpha"]],"bravo","2026-02-28",1,true],expected:[]},
    {name:"Leap-day birthday in a non-leap year",args:[[["A","B","02-29","alpha"]],"alpha","2026-02-28",1,true],
      expected:[{date:"2026-03-01",people:[{firstName:"A",lastName:"B",flightId:"alpha"}]}]},
  ],
};
