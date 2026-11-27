/** Pure native spreadsheet input capture. Current row labels never establish target identity. */
import {AdapterError, type AdapterConfig, type Signer} from './index.js';
import {parseAdminCommand, DIRECTORY_FIELDS, type AdminCommand, type FrontendSnapshot} from '../../../packages/domain/src/admin.js';
import {parseAttendanceCorrection, type AttendanceCorrectionCommand} from '../../../packages/domain/src/corrections.js';
import {parseCommand, type ExcusalDecideCommand} from '../../../packages/domain/src/index.js';
import {applyFrontendReceipt, type FrontendDraft, type FrontendPublicationBaseline, type FrontendTableRead, type FrontendValue, type NativeCellData} from './frontend-publication.js';

export type InputSurface = 'directory'|'leadership'|'attendance'|'blue'|'gold';
export interface InputSurfaceBinding {surface:InputSurface;spreadsheetId:string;sheetId:number;tableId:string;resourceKey:string}
export interface NativeEditEvidence {
  spreadsheetId:string;sheetId:number;row:number;column:number;rows:number;columns:number;
  value?:string;oldValue?:string;actorEmail?:string;triggerUid:string;
}
export interface InputPrincipal {email:string;principalId:string}
export type FrontendInputContext=Pick<FrontendSnapshot,'environment'|'generation'|'people'|'leadership'|'flights'> & {
  events:Pick<FrontendSnapshot['events'][number],'eventId'|'label'|'columnLabel'|'version'|'status'>[];
};
export type InputCommand = AdminCommand|AttendanceCorrectionCommand|ExcusalDecideCommand;
export interface FrozenInputTemplate {operation:InputCommand['operation'];payload:InputCommand['payload'];path:'/v1/admin/commands'|'/v1/commands';drafts:FrontendDraft[]}
export interface CapturedFrontendEdit {
  editId:string;surface:InputSurface;resourceKey:string;generation:number;environment:'staging';
  evidence:NativeEditEvidence;drafts:FrontendDraft[];templates:FrozenInputTemplate[];
  summary:string;summaryHash:string;status:'ready'|'confirmation-required'|'noop';principalId?:string;
}
function fail(code:string,message:string):never{throw new AdapterError(code,message);}
const clone=<T>(x:T):T=>JSON.parse(JSON.stringify(x));
export const inputCanonical=(x:unknown):string=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const equal=(a:unknown,b:unknown)=>inputCanonical(a)===inputCanonical(b);
const natural=(x:unknown,min=0)=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=min;
function hash(s:Signer,v:unknown){const result=s.sha256(inputCanonical(v));if(!/^[a-f0-9]{64}$/.test(result))fail('input_identity','Invalid input digest.');return result;}
export function nativeInputValue(cell:NativeCellData|undefined):FrontendValue{
  if(!cell)return null;
  if(cell.userEnteredValue?.formulaValue!==undefined)fail('input_formula','Formulas are not accepted as operational input.');
  if(cell.chipRuns?.length){
    if(cell.chipRuns.length!==1||!cell.chipRuns[0].chip?.richLinkProperties?.uri||cell.chipRuns[0].chip?.personProperties)fail('input_value','Ambiguous native file chip.');
    return {fileUri:cell.chipRuns[0].chip.richLinkProperties.uri};
  }
  const v=cell.userEnteredValue;if(!v)return null;
  if(v.stringValue!==undefined)return v.stringValue===''?null:v.stringValue;
  if(v.numberValue!==undefined&&Number.isFinite(v.numberValue))return v.numberValue;
  if(v.boolValue!==undefined)return v.boolValue;
  fail('input_value','Unsupported native cell value.');
}
const scalar=(v:FrontendValue):string=>v===null?'':typeof v==='object'?v.fileUri:String(v);
// Google omits empty native cells even when the published source was an empty
// string. Keep the baseline intact, but compare its visible blank consistently.
const nativeComparable=(v:FrontendValue):FrontendValue=>v===''?null:v;
const eventScalar=(v:FrontendValue):string|undefined=>v===null||v===''?undefined:typeof v==='object'?undefined:String(v);
function isoDate(v:FrontendValue):string|null{
  if(v===null)return null;
  if(typeof v==='number'&&Number.isInteger(v)){const date=new Date(Date.UTC(1899,11,30)+v*86400000);return date.toISOString().slice(0,10);}
  if(typeof v==='string'&&/^\d{4}-\d\d-\d\d$/.test(v))return v;
  fail('input_value','The date cell needs an unambiguous native date.');
}
function parsed(template:FrozenInputTemplate,actor:{principalId:string;evidence:'google-edit'|'authenticated-confirmation'},edit:Pick<CapturedFrontendEdit,'editId'|'environment'|'generation'|'resourceKey'>,index:number):InputCommand{
  const command={commandId:`input.${edit.editId}.${index}`,contractVersion:1,environment:edit.environment,generation:edit.generation,actor,
    source:{kind:'sheet',resourceKey:edit.resourceKey,submissionId:`input.${edit.editId}.${index}`,revision:1},operation:template.operation,payload:clone(template.payload)};
  return command.operation==='attendance.correct'?parseAttendanceCorrection(command):command.operation==='excusal.decide'?parseCommand(command) as ExcusalDecideCommand:parseAdminCommand(command);
}
function templates(drafts:FrontendDraft[],snapshot:FrontendInputContext):FrozenInputTemplate[]{
  const grouped=new Map<string,FrontendDraft[]>();
  for(const draft of drafts){if(!draft.command)fail('input_binding','The published command binding is missing.');const key=inputCanonical([draft.command.operation,draft.command.entityId,draft.command.operation==='attendance.correct'?draft.command.field:'']);const group=grouped.get(key)??[];group.push(draft);grouped.set(key,group);}
  return [...grouped.values()].map(cells=>{
    const command=cells[0].command!;
    if(cells.some(c=>c.command!.expectedVersion!==command.expectedVersion))fail('input_version','A row has conflicting frozen command versions.');
    let payload:InputCommand['payload'];
    if(command.operation==='directory.upsert'){
      const person=snapshot.people.find(p=>p.personId===command.entityId);
      if(!person||person.version!==command.expectedVersion)fail('input_version','The Directory changed after the published base; review the new version.');
      const profile=Object.fromEntries(DIRECTORY_FIELDS.map(k=>[k,person[k]]));let flightId=person.flightId;
      for(const c of cells){const field=c.command!.field;if(field==='flightId'){
        if(c.value===null)flightId=null;else{const matches=snapshot.flights.filter(f=>f.label===scalar(c.value));if(matches.length!==1)fail('input_binding','The selected Flight needs one exact current catalog identity.');flightId=matches[0].flightId;}
      }else{if(!(DIRECTORY_FIELDS as readonly string[]).includes(field))fail('input_binding','Unknown Directory field.');profile[field]=field==='dateOfBirth'?isoDate(c.value):scalar(c.value);}}
      payload={personId:person.personId,expectedVersion:command.expectedVersion,flightId,profile} as unknown as AdminCommand['payload'];
    }else if(command.operation==='leadership.upsert'){
      const contact=snapshot.leadership.find(p=>p.contactId===command.entityId);
      if(!contact||contact.contactVersion!==command.expectedVersion||cells.some(c=>c.baseVersion!==contact.publicationVersion))fail('input_version','The Leadership context changed after the published base.');
      const profile=contact.personId?null:{lastName:contact.lastName,firstName:contact.firstName,rank:contact.rank,role:contact.role,email:contact.email,cellPhone:contact.cellPhone};
      const next={contactId:contact.contactId,expectedVersion:contact.contactVersion,personId:contact.personId,profile,reportsTo:contact.reportsTo,officePhone:contact.officePhone,officeLocation:contact.officeLocation,active:contact.active};
      for(const c of cells){const field=c.command!.field;if(['reportsTo','officePhone','officeLocation'].includes(field))(next as unknown as Record<string,unknown>)[field]=scalar(c.value);
        else{if(!profile||!Object.hasOwn(profile,field))fail('input_binding','Linked cadet profile fields belong in Directory.');(profile as Record<string,string>)[field]=scalar(c.value);}}
      payload=next;
    }else if(command.operation==='attendance.correct'){
      if(cells.length!==1||!natural(cells[0].expectedEventVersion,1))fail('input_binding','Attendance needs its frozen event and pair versions.');
      payload={personId:command.entityId,eventId:command.field,expectedBaseVersion:command.expectedVersion,expectedEventVersion:cells[0].expectedEventVersion!,code:cells[0].value as any,reason:'Spreadsheet attendance correction.'};
    }else{
      if(cells.length!==1||command.field!=='decision')fail('input_binding','Only a single request decision is supported.');
      payload={requestId:command.entityId,expectedVersion:command.expectedVersion,decision:cells[0].value as any,reason:'Spreadsheet excusal decision.'};
    }
    return {operation:command.operation,payload,path:command.operation==='excusal.decide'?'/v1/commands':'/v1/admin/commands',drafts:clone(cells)};
  });
}
/** Verifies the complete protected physical map, never just the edited row's current hidden ID. */
export function assertImmutableInputSlots(baseline:FrontendPublicationBaseline,current:FrontendTableRead,surface:InputSurface):void{
  if(!baseline.slots||!equal(baseline.slots.headers,current.headers)||current.range.startRowIndex!==1||current.range.startColumnIndex!==0)fail('input_slots','Immutable native input slots have not been established.');
  const keyHeader=surface==='leadership'?'contact_id':['blue','gold'].includes(surface)?'request_id':'person_id',keyColumn=current.headers.indexOf(keyHeader);
  const keys=baseline.slots.keys.filter(key=>key!==null);
  if(keyColumn<0||new Set(current.headers).size!==current.headers.length||new Set(keys).size!==keys.length||new Set(baseline.rows.map(r=>r.key)).size!==baseline.rows.length||
    baseline.slots.keys.length!==current.rows.length||!equal(baseline.slots.keys,current.rows.map(r=>nativeInputValue(r[keyColumn]))))fail('input_slots','Physical rows or identities changed; reconcile structural edits first.');
}

/** Coordinates below are zero-based within the Table body. Preserve the original
 * trigger dimensions for identity and single-cell evidence after clipping. */
export function nativeInputBounds(e:NativeEditEvidence,current:FrontendTableRead,surface:InputSurface,baseline:FrontendPublicationBaseline){
  if(![e.row,e.column,e.rows,e.columns].every(n=>natural(n,1)))fail('input_range','Invalid native edit dimensions.');
  const row=Math.max(0,e.row-3),endRow=Math.min(current.rows.length,e.row-3+e.rows);
  const column=e.column-1,endColumn=Math.min(current.headers.length,column+e.columns);
  if(surface!=='attendance'&&(e.row<3||e.row-3+e.rows>current.rows.length||column+e.columns>current.headers.length))fail('input_range','Input is outside the published native Table body.');
  const retired=new Set(baseline.retiredEventColumns?.map(column=>column.header));
  const headerCount=surface==='attendance'?current.headers.slice(column,endColumn).filter(h=>h.startsWith('event:')&&!retired.has(h)).length:e.columns;
  if(Math.max(0,endRow-row)*headerCount>250)fail('input_capacity','Split the edit into groups of at most 250 input cells.');
  return {row,endRow,column,endColumn};
}

/** Private evidence for a paste, whose native trigger carries no per-cell values. */
export function attendanceReadEvidence(event:NativeEditEvidence,current:FrontendTableRead,baseline:FrontendPublicationBaseline){
  assertImmutableInputSlots(baseline,current,'attendance');
  const bounds=nativeInputBounds(event,current,'attendance',baseline),rows=new Map(baseline.rows.map(row=>[row.key,row]));
  const cells=[];
  for(let r=bounds.row;r<bounds.endRow;r++)for(let c=bounds.column;c<bounds.endColumn;c++){
    const header=current.headers[c];if(!header.startsWith('event:'))continue;
    const key=baseline.slots!.keys[r],row=key===null?undefined:rows.get(key);
    if(baseline.retiredEventColumns?.some(col=>col.header===header)){
      if(!equal(nativeComparable(row?.values[header]??null),nativeInputValue(current.rows[r][c])))fail('input_readonly','A retained inactive Attendance event was changed.');
      continue;
    }
    cells.push({key,header,label:current.labels[c],before:row?.values[header]??null,
      entered:nativeInputValue(current.rows[r][c]),pairVersion:row?.versions[header]??null,eventVersion:row?.eventVersions?.[header]??null});
  }
  return cells;
}
/** Physical slot immutability + reviewed provider behavior are prerequisites. Reading a current hidden ID alone is never sufficient. */
export function captureFrontendEdit(input:{event:NativeEditEvidence;binding:InputSurfaceBinding;baseline:FrontendPublicationBaseline;drafts:FrontendDraft[];
  current:FrontendTableRead;snapshot:FrontendInputContext;principals:InputPrincipal[];config:AdapterConfig;signer:Signer;providerCoordinatesVerified:boolean;automationEmail:string;captureSequence?:number}):CapturedFrontendEdit{
  const {event:e,binding:b,baseline,current,signer}=input;
  if(input.config.environment!=='staging'||baseline.generation!==input.config.generation||input.snapshot.generation!==baseline.generation||input.snapshot.environment!=='staging'
    ||e.spreadsheetId!==b.spreadsheetId||e.sheetId!==b.sheetId||current.sheetId!==b.sheetId||current.tableId!==b.tableId)fail('input_binding','A bounded, exact edit binding is required.');
  assertImmutableInputSlots(baseline,current,b.surface);
  if(!natural(input.captureSequence??0))fail('input_identity','Invalid capture sequence.');
  const bounds=nativeInputBounds(e,current,b.surface,baseline);
  const rows=new Map(baseline.rows.map(row=>[row.key,row]));
  const checkedEvents=new Map<string,number>(),retired=new Set(baseline.retiredEventColumns?.map(c=>c.header));
  if(b.surface==='attendance'&&bounds.row<bounds.endRow){
    const labelKey=(label:string)=>label.trim().replace(/\s+/g,' ').toLowerCase();
    const seenLabels=new Set<string>(),duplicates=new Set<string>();
    current.headers.forEach((h,i)=>{if(!h.startsWith('event:')||retired.has(h)&&current.hiddenColumns.includes(i))return;const label=labelKey(current.labels[i]??'');if(seenLabels.has(label))duplicates.add(label);seenLabels.add(label);});
    for(let c=bounds.column;c<bounds.endColumn;c++){
      const header=current.headers[c];if(!header.startsWith('event:'))continue;
      if(retired.has(header)){
        if(!current.hiddenColumns.includes(c))fail('input_slots','A retained inactive Attendance event became visible.');
        continue;
      }
      const matches=input.snapshot.events.filter(event=>event.eventId===header.slice(6)),event=matches[0],label=current.labels[c];
      if(matches.length!==1||event.status!=='active'||!label||label!==(event.columnLabel||event.label)||duplicates.has(labelKey(label)))
        fail('input_binding','The visible Attendance event is stale or ambiguous; review the current event before submitting.');
      checkedEvents.set(header,event.version);
    }
    const names=['last_name','first_name'].map(h=>({h,c:current.headers.indexOf(h)})).filter(({c})=>c>=0);
    if(checkedEvents.size)for(let r=bounds.row;r<bounds.endRow;r++){
      const key=baseline.slots!.keys[r],row=key===null?undefined:rows.get(key);
      if(row&&names.some(({h,c})=>!equal(nativeComparable(row.values[h]??null),nativeInputValue(current.rows[r][c]))))fail('input_slots','Attendance names moved relative to their protected row identities.');
    }
  }
  const drafts:FrontendDraft[]=[],lines:string[]=[];
  for(let r=bounds.row;r<bounds.endRow;r++)for(let c=bounds.column;c<bounds.endColumn;c++){
    const key=baseline.slots!.keys[r],header=current.headers[c],row=key===null?undefined:rows.get(key),value=nativeInputValue(current.rows[r][c]);
    if(b.surface==='attendance'&&e.rows===1&&e.columns===1&&header.startsWith('event:')&&(e.value!==undefined||e.oldValue!==undefined)&&e.value!==eventScalar(value))
      fail('input_changed','The Attendance cell no longer contains the value from this edit.');
    if(b.surface==='attendance'&&key===null&&value===null)continue;
    if(b.surface==='attendance'&&row?.retired&&equal(nativeComparable(row.values[header]??null),value))continue;
    if(!row||row.retired)fail('input_slots','This physical row is not an active published identity.');
    const before=nativeComparable(row.values[header]??null);
    if(equal(before,value))continue;
    if(b.surface==='attendance'&&retired.has(header)||row.readonlyHeaders?.includes(header)||!row.commandBindings?.[header]||!natural(row.versions[header]))fail('input_readonly','A protected identity or derived field was changed.');
    const binding=row.commandBindings[header];
    const expectedOperation=b.surface==='directory'?'directory.upsert':b.surface==='leadership'?'leadership.upsert':b.surface==='attendance'?'attendance.correct':'excusal.decide';
    if(binding.entityId!==row.key||binding.operation!==expectedOperation||(b.surface==='attendance'&&header!==`event:${binding.field}`)||(['blue','gold'].includes(b.surface)&&(header!=='decision'||binding.field!=='decision')))fail('input_binding','The row key and protected command target disagree.');
    if(b.surface==='attendance'&&(checkedEvents.get(header)!==row.eventVersions?.[header]||row.versions[header]!==binding.expectedVersion))
      fail('input_version','The Attendance event or its published version changed.');
    const prior=input.drafts.filter(d=>d.key===key&&d.header===header);
    if(prior.length>1||prior.length===1&&!equal(prior[0].value,value))fail('input_pending','Resolve the previous frozen input before replacing this cell.');
    const draft:FrontendDraft=prior[0]?clone(prior[0]):{key:row.key,header,value,baseVersion:row.versions[header],command:clone(row.commandBindings[header]),...(header.startsWith('event:')?{expectedEventVersion:row.eventVersions?.[header]}:{})};
    if(draft.baseVersion!==row.versions[header]||!equal(draft.command,binding)||(header.startsWith('event:')&&draft.expectedEventVersion!==row.eventVersions?.[header]))fail('input_version','The retained draft no longer matches its original published base.');
    drafts.push(draft);
    const name=[scalar(row.values.last_name??null),scalar(row.values.first_name??null)].filter(Boolean).join(', ')||row.key;
    lines.push(`${b.surface}: ${name} — ${current.labels[c]||header}: ${scalar(before)||'(blank)'} → ${scalar(value)||'(blank)'}`);
  }
  const summary=lines.join('\n');if(summary.length>16000)fail('input_capacity','Split this edit into smaller reviewed groups.');
  const frozen=templates(drafts,input.snapshot),actor=input.principals.filter(p=>p.email.trim().toLowerCase()===e.actorEmail?.trim().toLowerCase());
  const only=drafts.length===1?drafts[0]:undefined,row=only?baseline.rows.find(r=>r.key===only.key):undefined;
  const directlyObserved=e.rows===1&&e.columns===1&&only&&row&&equal(e.value,eventScalar(only.value))&&equal(e.oldValue,eventScalar(row.values[only.header]??null));
  const direct=Boolean(directlyObserved&&input.providerCoordinatesVerified&&actor.length===1&&e.actorEmail?.trim().toLowerCase()!==input.automationEmail.trim().toLowerCase());
  const editId=hash(signer,{generation:input.config.generation,binding:b,drafts,captureSequence:input.captureSequence??0,evidence:{...e,triggerUid:undefined}});
  const captured:CapturedFrontendEdit={editId,surface:b.surface,resourceKey:b.resourceKey,generation:input.config.generation,environment:'staging',evidence:clone(e),drafts,templates:frozen,summary,summaryHash:hash(signer,summary),status:!drafts.length?'noop':direct?'ready':'confirmation-required',...(direct?{principalId:actor[0].principalId}:{})};
  frozen.forEach((t,i)=>parsed(t,{principalId:captured.principalId??'validation-only',evidence:'google-edit'},captured,i));
  return captured;
}
export function commandsForCapturedEdit(input:{edit:CapturedFrontendEdit;confirmation?:{verifiedEmail:string;verified:boolean;reference:string;summary:string;action:string};principals:InputPrincipal[]}):InputCommand[]{
  const {edit}=input;let principalId=edit.principalId,evidence:'google-edit'|'authenticated-confirmation'='google-edit';
  if(edit.status==='noop')return[];
  if(input.confirmation){const c=input.confirmation,actor=input.principals.filter(p=>p.email.trim().toLowerCase()===c.verifiedEmail.trim().toLowerCase());
    if(!c.verified||c.reference!==edit.editId||c.summary!==edit.summary||c.action!=='Confirm these changes'||actor.length!==1)fail('input_confirmation','The verified confirmation does not match the exact frozen changes.');
    principalId=actor[0].principalId;evidence='authenticated-confirmation';
  }else if(edit.status!=='ready')fail('confirmation_required','Verify the frozen spreadsheet changes before submitting.');
  if(!principalId)fail('confirmation_required','Verified human identity is required.');
  return edit.templates.map((t,i)=>parsed(t,{principalId,evidence},edit,i));
}
/** Called only for a matching committed response from the signed Worker transport. */
export function reconcileInputReceipt(input:{baseline:FrontendPublicationBaseline;drafts:FrontendDraft[];template:FrozenInputTemplate;command:InputCommand;receipt:unknown}):{baseline:FrontendPublicationBaseline;drafts:FrontendDraft[]}{
  const receipt=input.receipt as any,c=input.command;
  if(!receipt||receipt.commandId!==c.commandId||receipt.status!=='committed'||receipt.operation!==c.operation||!equal(c.payload,input.template.payload))fail('input_receipt','The receipt does not identify the frozen command.');
  let version:number;
  if(c.operation==='attendance.correct'){
    if(receipt.result?.personId!==c.payload.personId||receipt.result?.eventId!==c.payload.eventId||receipt.result?.code!==c.payload.code)fail('input_receipt','Attendance receipt target or value differs.');version=receipt.result.version;
  }else if(c.operation==='excusal.decide'){
    if(receipt.result?.requestId!==c.payload.requestId||receipt.result?.decision!==c.payload.decision)fail('input_receipt','Decision receipt target or value differs.');version=receipt.result.version;
  }else{
    const target=c.operation==='directory.upsert'?c.payload.personId:c.operation==='leadership.upsert'?c.payload.contactId:undefined;
    if(receipt.result?.targetId!==target)fail('input_receipt','Profile receipt target differs.');version=receipt.result.version;
  }
  const expected=input.template.drafts[0].command!.expectedVersion;
  if(!natural(version,expected+1)||(c.operation!=='attendance.correct'&&version!==expected+1))fail('input_receipt','The committed version does not advance the frozen base exactly.');
  let result={baseline:clone(input.baseline),drafts:clone(input.drafts)};
  for(const draft of input.template.drafts){const published=c.operation==='leadership.upsert'?draft.baseVersion+(version-expected):version;
    result=applyFrontendReceipt({...result,draft,receiptVerified:true,receipt:{key:draft.key,header:draft.header,baseVersion:draft.baseVersion,committedVersion:published,value:draft.value,expectedEventVersion:draft.expectedEventVersion,command:{...draft.command!,committedVersion:version}}});}
  return result;
}

/** One-time reviewed bootstrap under the native edit fence; never reorders or rewrites cells. */
export function bindImmutableInputSlots(input:{baseline:FrontendPublicationBaseline;current:FrontendTableRead;keyHeader:string;editFenceVerified:boolean}):FrontendPublicationBaseline{
  const {baseline,current}=input;if(!input.editFenceVerified||current.range.startRowIndex!==1||current.range.startColumnIndex!==0||new Set(current.headers).size!==current.headers.length)fail('input_slots','Fence the exact native Table before binding physical slots.');
  const keyColumn=current.headers.indexOf(input.keyHeader);if(keyColumn<0)fail('input_slots','The protected identity column is missing.');
  const keys=current.rows.map(row=>nativeInputValue(row[keyColumn]));if(keys.some(k=>k!==null&&typeof k!=='string')||new Set(keys.filter(k=>k!==null)).size!==keys.filter(k=>k!==null).length)fail('input_slots','Native physical identities are missing or duplicated.');
  const found=new Set<string>();
  for(let i=0;i<keys.length;i++){
    if(keys[i]===null){if(current.rows[i].some(cell=>nativeInputValue(cell)!==null))fail('input_slots','A populated native row has no protected identity.');continue;}
    const key=keys[i] as string,rows=baseline.rows.filter(row=>row.key===key);if(rows.length!==1)fail('input_slots','The native row has no exact published baseline.');found.add(key);
    for(let c=0;c<current.headers.length;c++)if(!equal(nativeInputValue(current.rows[i][c]),nativeComparable(rows[0].values[current.headers[c]]??null)))fail('input_slots','Resolve unsent native values before establishing immutable slots.');
  }
  if(baseline.rows.some(row=>!found.has(row.key)))fail('input_slots','A published identity is missing from the native Table.');
  const slots={headers:[...current.headers],keys:keys as (string|null)[]};if(baseline.slots&&!equal(baseline.slots,slots))fail('input_slots','Existing immutable physical bindings cannot be reassigned.');
  return {...clone(baseline),slots};
}
