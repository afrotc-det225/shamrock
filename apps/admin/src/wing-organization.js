// The Det 225 chart defines offices and reporting lines. Occupants come from the
// authorized Directory/Leadership read. These display mappings confer no permissions.
const office = (id,title,roles,code="",options={}) => ({id,title,roles,code,...options});
const deputy = (roles,code="") => ({roles,code});
const normalize = value => String(value ?? "").toLowerCase().replaceAll("&"," and ").replace(/[^a-z0-9]+/g," ").trim();

function offices(roster) {
  const operations = roster.squadrons.flatMap(sq => {
    const flights = roster.flights.filter(f=>f.squadronId===sq.squadronId)
      .sort((a,b)=>a.label.localeCompare(b.label));
    if (!["blue","gold"].includes(normalize(sq.label)) && !flights.some(f=>
      roster.leadership.some(p=>normalize(p.role)===normalize(f.label+" Flight Commander")))) return [];
    return [office(sq.squadronId,sq.label+" Squadron",[sq.label+" Squadron Commander"],sq.label+" Sq/CC",{
      tone:normalize(sq.label), deputy:deputy([sq.label+" Deputy Squadron Commander",sq.label+" Squadron Deputy Commander"]),
      children:flights.map(f=>{
        const letters={alpha:"A",bravo:"B",charlie:"C",delta:"D",echo:"E",foxtrot:"F"};
        const letter=letters[normalize(f.label)];
        const symbol=letter ? sq.label+" Sq/DO"+letter : "";
        return office(f.flightId,f.label+" Flight",[f.label+" Flight Commander"],symbol,{
          deputy:deputy([f.label+" Deputy Flight Commander",f.label+" Flight Deputy Commander"],symbol),
        });
      }),
    })];
  });
  const support = [
    office("pa","Public Affairs & Outreach",["Chief, Public Affairs & Outreach"],"225 MSS/PA",{children:[
      office("social","Social Media",["PA/PO - Social Media"],"225 MSS/PAM"),
      office("publications","Publications",["PA/PO - Publications"],"225 MSS/PAP"),
    ]}),
    office("logistics","Logistics",["Chief, Logistics"],"225 MSS/LR",{children:[
      office("supply","Supply",["Logistics - Supply"],"225 MSS/LRS"),
      office("uniform","Uniform",["Logistics - Uniform"],"225 MSS/LRU"),
      office("trainers","Trainers / Simulators",["Logistics - Trainers/Simulators"],"225 MSS/LRT"),
    ]}),
    office("tri","Tri-Military",["Chief, Tri-Military Operations"],"225 MSS/TM",{children:[
      office("guard","Color Guard",["Tri-Military - Color Guard"],"225 MSS/TMC"),
    ]}),
    office("mwr","MWR",["Chief, Morale, Welfare, & Recreation"],"225 MSS/MW",{children:[
      office("fiit","FIIT Task Force",["FIIT Task Force Commander"],"FIIT TF/CC",{members:["FIIT Task Force"]}),
      office("ball","Air Force Ball Task Force",["Air Force Ball Task Force Commander"],"AFB TF/CC",{members:["Air Force Ball Task Force"]}),
    ]}),
    office("liaison","Crosstown Liaison TF",["Crosstown Liaison Task Force Commander"],"CTL TF/CC",{members:["Crosstown Liaison Task Force"]}),
  ];
  return office("wing","Wing Commander",["Cadet Wing Commander","Wing Commander"],"225 CW/CC",{
    deputy:deputy(["Deputy Wing Commander","Cadet Wing Deputy Commander"],"225 CW/CD"),
    children:[
      office("gmc","Senior GMC Advisor",["Senior GMC Advisor"],"225 CW/SGA",{deputy:deputy(["Deputy GMC Advisor"],"225 CW/DGA")}),
      office("mss","Mission Support Squadron",["Mission Support Squadron Commander"],"225 MSS/CC",{
        deputy:deputy(["Mission Support Squadron Deputy Commander","Deputy Mission Support Squadron Commander"],"225 MSS/CD"),children:support}),
      office("evaluations","Evaluations",["Chief, Operations Group Evaluations"],"225 OG/OGV",{
        deputy:deputy(["Deputy, Operations Group Evaluations"],"225 OG/OGV")}),
      office("operations","Operations Group",["Operations Group Commander"],"225 OG/CC",{
        deputy:deputy(["Operations Group Deputy Commander","Deputy Operations Group Commander"],"225 OG/CD"),children:operations}),
      office("plans","Plans & Exercises",["Chief, Wing Plans & Exercises"],"225 CW/XP",{children:[
        office("llab","LLAB Operations",["LLAB Operations"],"225 CW/XPL"),
        office("fitness","Fitness Operations",["Fitness Operations"],"225 CW/XPF",{children:[
          office("ptl","Physical Training Leaders",["Physical Training Leaders","Physical Training Leader"],"225 CW/XPFL"),
        ]}),
      ]}),
    ],
  });
}

export function buildWingOrganization(roster) {
  const records=new Map();
  for(const person of roster.people) {
    if(person.active===false || ["Inactive","Dropped","Commissioned"].includes(person.flightPathStatus) || !person.role) continue;
    records.set(person.personId,person);
  }
  for(const contact of roster.leadership) {
    const key=contact.personId ?? contact.contactId;
    if(contact.active===false) { records.delete(key); continue; }
    const person=records.get(key);
    records.set(key,{...person,...contact,role:contact.role || person?.role || ""});
  }
  const root=offices(roster),roles=new Map();
  function register(node) {
    node.assigned=[];node.team=[];
    const add=(titles,slot)=>titles?.forEach(title=>roles.set(normalize(title),slot));
    add(node.roles,node.assigned);
    if(node.deputy){node.deputy.assigned=[];add(node.deputy.roles,node.deputy.assigned);}
    add(node.members,node.team);
    node.children?.forEach(register);
  }
  register(root);
  const other=[];
  for(const person of records.values()) {
    // Match whole titles first: an ampersand can be part of an office name.
    const exact=roles.get(normalize(person.role));
    const appointments=exact ? [exact] : person.role.split(/;|\s+&\s+/).map(s=>roles.get(normalize(s))).filter(Boolean);
    if(!appointments.length) other.push(person);
    for(const slot of new Set(appointments))slot.push(person);
  }
  return {root,other};
}

export function filterWingOrganization(node,query) {
  const match=text=>String(text ?? "").toLowerCase().includes(query);
  const matchesPerson=p=>[p.firstName+" "+p.lastName,p.email,p.role,p.rank].some(match);
  if(!query || match(node.title) || (node.code && match(node.code))) return node;
  const assigned=node.assigned.filter(matchesPerson);
  const deputy=node.deputy && {...node.deputy,assigned:node.deputy.assigned.filter(matchesPerson)};
  const team=node.team.filter(matchesPerson);
  const children=node.children?.map(child=>filterWingOrganization(child,query)).filter(Boolean);
  return assigned.length || deputy?.assigned.length || team.length || children?.length
    ? {...node,assigned,deputy,team,children,filtered:true,contextOnly:!assigned.length}
    : null;
}
