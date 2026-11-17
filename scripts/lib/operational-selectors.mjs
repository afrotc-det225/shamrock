/** Explicit set selection. Exclusions always win; no names become record identities. */
const norm=v=>String(v??'').trim().toLowerCase();
const FIELDS={cadets:['personId','name','flightId','flight','squadronId','squadron','university','asYear'],events:['eventId','label','columnLabel','eventType','termId','status','trainingWeek']};
export function selectorPredicate(expression,kind){
 let nodes=0;
 function compile(e,depth){
  if(!e||typeof e!=='object'||Array.isArray(e)||depth>8||++nodes>64)throw Error('SELECTOR_SHAPE');
  const keys=Object.keys(e).sort().join(',');
  if(keys==='all'&&e.all===true)return()=>true;
  if(keys==='and'||keys==='or'){
   const children=e[keys];if(!Array.isArray(children)||children.length<1||children.length>32)throw Error('SELECTOR_BRANCH');
   const predicates=children.map(child=>compile(child,depth+1));return row=>keys==='and'?predicates.every(p=>p(row)):predicates.some(p=>p(row));
  }
  if(keys!=='field,op,values'||!FIELDS[kind]?.includes(e.field)||!['in','startsWith','endsWith','contains'].includes(e.op)||!Array.isArray(e.values)||!e.values.length||e.values.length>500||e.values.some(v=>typeof v!=='string'||!v.trim()||v.length>512))throw Error('SELECTOR_LEAF');
  const isId=e.field.endsWith('Id');if(isId&&e.op!=='in')throw Error('SELECTOR_ID_OPERATOR');
  const normalize=v=>isId?String(v):e.field==='name'?String(v).split(',').map(norm).join(','):norm(v);
  const values=e.values.map(normalize);if(new Set(values).size!==values.length)throw Error('SELECTOR_DUPLICATE');
  return row=>{const value=normalize(row[e.field]);return values.some(v=>e.op==='in'?value===v:e.op==='startsWith'?value.startsWith(v):e.op==='endsWith'?value.endsWith(v):value.includes(v));};
 }
 return compile(expression,0);
}
export function selectRecords(rows,selection,kind){
 if(!selection||Object.keys(selection).some(k=>!['include','exclude','includeIds','excludeIds'].includes(k))||!selection.include)throw Error('SELECTOR_EXPLICIT_INCLUDE_REQUIRED');
 const include=selectorPredicate(selection.include,kind),exclude=selection.exclude?selectorPredicate(selection.exclude,kind):()=>false,key=kind==='cadets'?'personId':'eventId';
 const index=new Set(rows.map(r=>r[key]));if(index.size!==rows.length)throw Error('SELECTOR_AMBIGUOUS_RECORDS');
 const ids=(v=[])=>{if(!Array.isArray(v)||v.length>500||new Set(v).size!==v.length||v.some(id=>!index.has(id)))throw Error('SELECTOR_UNKNOWN_ID');return new Set(v);};
 const added=ids(selection.includeIds),removed=ids(selection.excludeIds);
 return rows.filter(row=>(include(row)||added.has(row[key]))&&!exclude(row)&&!removed.has(row[key]));
}
/** Exact legacy OR semantics, including its no-filter-all and additive Abroad behavior. */
export function translateLegacySelectors({eventSelector={},cadetSelector={}}){
 const legacyEventKeys=['all','names','startsWith','endsWith','contains'],legacyCadetKeys=['cadets','flights','universities','asYears','includeAbroad'];
 if(Object.keys(eventSelector).some(k=>!legacyEventKeys.includes(k))||Object.keys(cadetSelector).some(k=>!legacyCadetKeys.includes(k)))throw Error('SELECTOR_LEGACY_FIELDS');
 const leaf=(field,op,values)=>({field,op,values}),event=[];
 for(const [key,op]of [['names','in'],['startsWith','startsWith'],['endsWith','endsWith'],['contains','contains']])if(eventSelector[key]?.length)event.push(leaf('columnLabel',op,eventSelector[key]));
 if(!eventSelector.all&&!event.length)throw Error('SELECTOR_NO_EVENTS');
 const cadets=[];
 for(const [key,field]of [['cadets','name'],['flights','flight'],['universities','university'],['asYears','asYear']])if(cadetSelector[key]?.length)cadets.push(leaf(field,'in',key==='cadets'?cadetSelector[key].map(v=>String(v).split(',').map(norm).join(',')):cadetSelector[key]));
 if(cadetSelector.includeAbroad)cadets.push(leaf('flight','in',['Abroad']));
 const result={events:{include:eventSelector.all?{all:true}:event.length===1?event[0]:{or:event}},cadets:{include:cadets.length===0?{all:true}:cadets.length===1?cadets[0]:{or:cadets}},abroad:'include'};
 selectorPredicate(result.events.include,'events');selectorPredicate(result.cadets.include,'cadets');return result;
}
