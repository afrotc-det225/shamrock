// The Det 225 chart defines offices and reporting lines. Occupants come from the
// authorized Directory/Leadership read. These display mappings confer no permissions.
const office = (id,title,roles,code="",options={}) => ({id,title,roles,code,...options});
const deputy = (roles,code="") => ({roles,code});
const normalize = value => String(value ?? "").toLowerCase().replaceAll("&"," and ").replace(/[^a-z0-9]+/g," ").trim();

function offices(roster) {
  function flightOffice(f,sq) {
    const letter={alpha:"A",bravo:"B",charlie:"C",delta:"D",echo:"E",foxtrot:"F"}[normalize(f.label)];
    const symbol=sq && letter ? sq.label+" Sq/DO"+letter : "";
    return office(f.flightId,f.label+" Flight",[f.label+" Flight Commander"],symbol,{
      flight:true,deputy:deputy([f.label+" Deputy Flight Commander",f.label+" Flight Deputy Commander"],symbol),
    });
  }
  const sortedFlights=[...roster.flights].sort((a,b)=>a.label.localeCompare(b.label));
  const operations=roster.squadrons.map(sq=>office(sq.squadronId,sq.label+" Squadron",
    [sq.label+" Squadron Commander"],sq.label+" Sq/CC",{
      tone:normalize(sq.label),deputy:deputy([sq.label+" Deputy Squadron Commander",sq.label+" Squadron Deputy Commander"]),
      children:sortedFlights.filter(f=>f.squadronId===sq.squadronId).map(f=>flightOffice(f,sq)),
    }));
  for(const flight of sortedFlights) {
    if(!roster.squadrons.some(sq=>sq.squadronId===flight.squadronId)) operations.push(flightOffice(flight));
  }
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

// Prefer a whole title (many office names contain "&"), then recover distinct
// appointments on either side of an ampersand when one is a known office.
function splitTitles(title, roles) {
  const whole = title.trim();
  if (!whole || roles.has(normalize(whole))) return whole ? [whole] : [];
  const parts = whole.split(/\s+&\s+/);
  for (let i=1;i<parts.length;i++) {
    const left=parts.slice(0,i).join(" & "), right=parts.slice(i).join(" & ");
    if (roles.has(normalize(left)) || roles.has(normalize(right)) || /^(?:\w+ (?:flight|flt) |mss - )/i.test(right)) {
      return [...splitTitles(left,roles),...splitTitles(right,roles)];
    }
  }
  return [whole];
}

export function buildWingOrganization(roster) {
  const wing=offices(roster);
  const ops=office("cadre-operations","Operations Officer",["Operations Officer","Ops Officer","Detachment Operations Officer"],"",{children:[wing]});
  const root=office("detachment","Detachment Commander",["Commander","Detachment Commander"],"",{children:[ops]});
  const roles=new Map(), flights=new Map(), records=new Map();
  function register(node) {
    node.assigned=[];node.team=[];
    for(const title of node.roles) roles.set(normalize(title),node.assigned);
    if(node.deputy) {
      node.deputy.assigned=[];
      for(const title of node.deputy.roles) roles.set(normalize(title),node.deputy.assigned);
    }
    for(const title of node.members || []) roles.set(normalize(title),node.team);
    if(node.flight) flights.set(node.id,node);
    node.children?.forEach(register);
  }
  register(root);
  function child(parent,title) {
    const id=parent.id+"/"+normalize(title);
    parent.children ??= [];
    let node=parent.children.find(n=>n.id===id);
    if(!node) {node={id,title,assigned:[],team:[]};parent.children.push(node);}
    return node;
  }
  for(const person of roster.people) {
    if(person.active!==false && !["Inactive","Dropped","Commissioned"].includes(person.flightPathStatus)) records.set(person.personId,person);
  }
  for(const contact of roster.leadership) {
    if(contact.active===false || contact.active===0) continue;
    const person=records.get(contact.personId);
    if(contact.personId && !person) continue;
    // Cadet identity, personal contact details and appointments belong to the Directory.
    // The linked contact supplies only office details and its edit version.
    records.set(contact.personId || contact.contactId, person ? {
      ...person, contactId:contact.contactId, contactVersion:contact.contactVersion ?? contact.version,
      officePhone:contact.officePhone, officeLocation:contact.officeLocation, reportsTo:contact.reportsTo,
    } : contact);
  }
  const staff=[];
  const operations=wing.children.find(n=>n.id==="operations"), support=wing.children.find(n=>n.id==="mss");
  const prefixes=[];
  for(const f of roster.flights) {
    const node=flights.get(f.flightId);
    if(!node) continue;
    prefixes.push([normalize(f.label+" Flight")+" ",node]);
    const letter={alpha:"a",bravo:"b",charlie:"c",delta:"d",echo:"e",foxtrot:"f"}[normalize(f.label)];
    if(letter) prefixes.push([letter+" flt ",node]);
  }
  const ordered=[...records.values()].sort((a,b)=>(a.lastName || "").localeCompare(b.lastName || "") || (a.firstName || "").localeCompare(b.firstName || ""));
  for(const person of ordered) {
    const slots=new Set();
    const raw=person.role || "";
    const titles=raw.split(";").flatMap(t=>splitTitles(t,roles));
    const flight=flights.get(person.flightId);
    const homeFlight=()=>flight || child(operations,"Flight unassigned");
    for(const title of titles) {
      const normalized=normalize(title);
      const known=flight?.roles.some(r=>normalize(r)===normalized) ? flight.assigned :
        flight?.deputy.roles.some(r=>normalize(r)===normalized) ? flight.deputy.assigned : roles.get(normalized);
      if(known) {slots.add(known);continue;}
      if(!person.personId) {staff.push(person);break;}
      if(flight && ["flight commander","deputy flight commander","flight deputy commander"].includes(normalized)) {
        slots.add(normalized==="flight commander" ? flight.assigned : flight.deputy.assigned);
        continue;
      }
      if(normalized==="squadron commander" && flight) {
        const squadron=operations.children.find(n=>n.children?.includes(flight));
        if(squadron) {slots.add(squadron.assigned);continue;}
      }
      const matches=prefixes.filter(([prefix])=>normalized.startsWith(prefix));
      const entry=matches.find(([,node])=>node===flight) || matches[0];
      if(entry) {
        const duty=title.replace(/^.*?\b(?:flight|flt)\s+/i,"");
        slots.add(child(entry[1],duty).assigned);
      } else if(/^MSS\s*-\s*/i.test(title)) {
        slots.add(child(support,title.replace(/^MSS\s*-\s*/i,"")).assigned);
      } else slots.add(child(homeFlight(),title).assigned);
    }
    if(!titles.length) {
      if(person.personId) slots.add(homeFlight().team);
      else staff.push(person);
    }
    for(const slot of slots) slot.push(person);
  }
  // Standalone cadre contacts identify their supervisor by office title.
  const officesByTitle=new Map([...root.roles.map(t=>[normalize(t),root]),...ops.roles.map(t=>[normalize(t),ops])]);
  const staffOffices=new Map();
  for(const person of staff) {
    const title=person.role || "Cadre contact", id=normalize(title);
    if(!staffOffices.has(id)) staffOffices.set(id,{id:"cadre/"+id,title,assigned:[],team:[],children:[]});
    const node=staffOffices.get(id);
    node.assigned.push(person);
    officesByTitle.set(id,node);
  }
  const parents=new Map();
  for(const node of staffOffices.values()) {
    const supervisors=new Set(node.assigned.map(p=>officesByTitle.get(normalize(p.reportsTo))).filter(Boolean));
    parents.set(node,supervisors.size===1 ? [...supervisors][0] : root);
  }
  for(const [node,parent] of parents) {
    const seen=new Set([node]);
    let ancestor=parent;
    while(ancestor && !seen.has(ancestor)) {seen.add(ancestor);ancestor=parents.get(ancestor);}
    (ancestor ? root : parent).children.push(node);
  }
  return {root,wing,records};
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
