import {profileChoices} from "../../../.build/v3/packages/domain/src/profile-choices.js";
import {PanelError} from "../errors.mjs";

const fields=["asYear","afsc","major","campus","flight","squadron","classYear","hasPendingExcusal","hasApprovedExcusal","hasDeniedExcusal"];
const bad=()=>new PanelError("ROSTER_QUERY","I couldn’t match that question to the roster. Please clarify which cadets to include.");
const byId = table => new Map(JSON.parse(table).map(row=>[row[0],row]));
const missing="Not recorded";
function known(value,options){
  const text=String(value??"").trim().toLowerCase();
  if(!text)return missing;
  return options.find(s=>s.toLowerCase()===text || s.split(" - ")[0].toLowerCase()===text) ?? "Other or unrecognized";
}
export function rosterDataset(t,excusalTables){
  const statuses=new Map();
  if(excusalTables)for(const [,personId,,,status] of JSON.parse(excusalTables.requests)){
    if(!statuses.has(personId))statuses.set(personId,new Set());
    statuses.get(personId).add(status);
  }
  const flights=byId(t.flights),squadrons=byId(t.squadrons);
  return JSON.parse(t.people).filter(r=>!["Inactive","Commissioned","Dropped"].includes(r[7])).map(r=>{
    const flight=flights.get(r[2]);
    const excusals=excusalTables ? Object.fromEntries([["hasPendingExcusal","Submitted"],["hasApprovedExcusal","Approved"],["hasDeniedExcusal","Denied"]].map(([key,status])=>[key,statuses.get(r[0])?.has(status)?"Yes":"No"])) : {};
    return {...excusals,id:r[0],first:r[4],last:r[3],asYear:/^(?:AS\s?\d{3}|AF\s?CIV)$/i.test(r[6])?r[6]:missing,
      classYear:/^\d{4}$/.test(r[12])?String(r[12]):missing,
      afsc:known(r[10],profileChoices.afsc),major:known(r[14],profileChoices.cipBroadArea),campus:known(r[11],profileChoices.university),
      flight:flight?.[1]??missing,squadron:squadrons.get(flight?.[2])?.[1]??missing};
  });
}
export function rosterVocabulary(rows){
  return Object.fromEntries(fields.filter(k=>rows.some(r=>r[k]!==undefined)).map(k=>[k,[...new Set(rows.map(r=>r[k]))].sort()]));
}
const clause={type:"object",additionalProperties:false,properties:{field:{type:"string",enum:fields},values:{type:"array",items:{type:"string"}}},required:["field","values"]};
export const planSchema={type:"object",additionalProperties:false,properties:{
  scope:{type:"string",enum:["active roster","previous result","clarify"]},filters:{type:"array",items:clause},
  listNames:{type:"boolean"},groupBy:{type:"string",enum:["none",...fields]},clarification:{type:"string"}
},required:["scope","filters","listNames","groupBy","clarification"]};
export function runRosterQuery(rows,plan,previous){
  if(plan.scope==="clarify")return {content:plan.clarification || "Which cadets should I include?"};
  if(!["active roster","previous result"].includes(plan.scope) || !Array.isArray(plan.filters) || plan.filters.length>fields.length || !["none",...fields].includes(plan.groupBy))throw bad();
  const prior=plan.scope==="previous result" ? new Set(checkIds(previous)) : null;
  const vocabulary=rosterVocabulary(rows);
  if(plan.groupBy!=="none" && !Object.hasOwn(vocabulary,plan.groupBy))throw bad();
  for(const f of plan.filters)if(!Object.hasOwn(vocabulary,f.field)||!Array.isArray(f.values)||!f.values.length||!f.values.every(v=>vocabulary[f.field].includes(v)))throw bad();
  const found=rows.filter(r=>(!prior||prior.has(r.id)) && plan.filters.every(f=>f.values.includes(r[f.field])));
  const counts=new Map();
  if(plan.groupBy!=="none")for(const r of found)counts.set(r[plan.groupBy],(counts.get(r[plan.groupBy])??0)+1);
  const condition=plan.filters.map(f=>f.field+" = "+f.values.join(" or ")).join("; ");
  const content=[found.length+" "+(found.length===1?"cadet":"cadets")+(prior?" from the previous result":" on the active roster")+".",condition,...[...counts].sort((a,b)=>b[1]-a[1]).map(([k,n])=>"- "+k+": "+n)].filter(Boolean).join("\n\n");
  return {content,cohort:{ids:found.map(r=>r.id),names:plan.listNames===true}};
}
export function checkIds(value){
  if(!Array.isArray(value)||value.length>2000||value.some(id=>typeof id!=="string"||id.length>180))throw bad();
  return value;
}
export function cohortNames(rows,ids){
  const members=new Set(checkIds(ids));
  return rows.filter(r=>members.has(r.id)).sort((a,b)=>a.last.localeCompare(b.last)||a.first.localeCompare(b.first)).map(r=>r.first+" "+r.last);
}
