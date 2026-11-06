/** Cooperative two-document input recovery. Caller holds the shared native ScriptLock. */
import {AdapterError} from './index.js';
import type {FrontendTableRead} from './frontend-publication.js';
import type {FrontendPublicationState} from './frontend-runtime.js';
import {assertImmutableInputSlots,inputCanonical,nativeInputValue,reconcileInputReceipt,type CapturedFrontendEdit,type InputCommand,type InputSurface,type NativeEditEvidence} from './frontend-input.js';
export interface InputDelivery {command:InputCommand;templateIndex:number;status:'queued'|'committed'|'conflict'|'rejected';attempted:boolean;receipt?:unknown;applied?:boolean}
export interface InputJournalEntry {edit:CapturedFrontendEdit;commands:InputDelivery[];confirmation?:{responseId:string;submittedAt:string;email:string};issue?:string;superseded?:boolean;supersededApplied?:boolean;noteStatus?:string}
export interface FrontendInputJournal {version:1;environment:'staging';generation:number;entries:Record<string,InputJournalEntry>;held?:Record<string,{event:unknown;issue:string}>}
export interface InputJournalPorts {
  journal:FrontendInputJournal;state:FrontendPublicationState;
  saveJournal(journal:FrontendInputJournal):void;saveState(state:FrontendPublicationState):void;
  sha256(text:string):string;
  send(path:'/v1/commands'|'/v1/admin/commands',command:InputCommand):{status:number;body:unknown};
  /** Exact current values before a first attempt; a retained ambiguous attempt must retry its original command. */
  stillVisible(edit:CapturedFrontendEdit):boolean;
}
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function fail(message:string):never{throw new AdapterError('input_journal',message);}
export function inputSurfaceState(state:FrontendPublicationState,surface:InputSurface){
  if(surface==='blue'||surface==='gold'){
    if(!state.supplemental)fail('The squadron input checkpoint is missing.');
    return {baseline:state.supplemental.baselines[surface],drafts:state.supplemental.drafts[surface],set(next:ReturnType<typeof reconcileInputReceipt>){state.supplemental!.baselines[surface]=next.baseline;state.supplemental!.drafts[surface]=next.drafts;}};
  }
  return {baseline:state.baselines[surface],drafts:state.drafts[surface],set(next:ReturnType<typeof reconcileInputReceipt>){state.baselines[surface]=next.baseline;state.drafts[surface]=next.drafts;}};
}
/** Journal first, then publisher holds. No signed delivery occurs in this function. */
export function retainCapturedInput(io:InputJournalPorts,edit:CapturedFrontendEdit,commands:InputCommand[]):InputJournalEntry{
  if(io.journal.version!==1||io.journal.environment!=='staging'||io.journal.generation!==edit.generation||io.state.generation!==edit.generation)fail('The private journals have different generations.');
  const prior=io.journal.entries[edit.editId];
  if(prior){if(inputCanonical(prior.edit)!==inputCanonical(edit))fail('A frozen input identity cannot change.');return prior;}
  const entry:InputJournalEntry={edit:copy(edit),commands:commands.map((command,templateIndex)=>({command:copy(command),templateIndex,status:'queued',attempted:false}))};
  io.journal.entries[edit.editId]=entry;io.saveJournal(io.journal);ensureHolds(io,entry);return entry;
}
function ensureHolds(io:InputJournalPorts,entry:InputJournalEntry){
  const table=inputSurfaceState(io.state,entry.edit.surface);let changed=false;
  for(const draft of entry.edit.drafts){
    const marker=entry.commands.find(c=>entry.edit.templates[c.templateIndex].drafts.some(d=>d.key===draft.key&&d.header===draft.header));
    if(marker && (marker.applied || io.state.inputReceipts?.[marker.command.commandId]))continue;
    const row=table.baseline.rows.find(r=>r.key===draft.key);
    if(!row||row.versions[draft.header]!==draft.baseVersion||inputCanonical(row.commandBindings?.[draft.header])!==inputCanonical(draft.command)){
      fail('The original input base changed before its hold was persisted.');
    }
    const prior=table.drafts.filter(d=>d.key===draft.key&&d.header===draft.header);
    if(prior.length>1||prior.length===1&&inputCanonical(prior[0])!==inputCanonical(draft))fail('Another frozen input already owns this cell.');
    if(!prior.length){table.drafts.push(copy(draft));changed=true;}
  }
  if(changed)io.saveState(io.state);
}
function cleanupSuperseded(io:InputJournalPorts,entry:InputJournalEntry){
  if(!entry.superseded||entry.supersededApplied)return;
  if(entry.commands.some(c=>c.attempted))fail('An attempted command cannot be superseded.');
  const table=inputSurfaceState(io.state,entry.edit.surface);
  const drafts=table.drafts.filter(d=>!entry.edit.drafts.some(old=>inputCanonical(old)===inputCanonical(d)));
  if(drafts.length!==table.drafts.length){table.set({baseline:table.baseline,drafts});io.saveState(io.state);}
  entry.supersededApplied=true;io.saveJournal(io.journal);
}
/** A later native edit may replace only wholly covered, never-dispatched frozen input. Journal before removing holds. */
export function supersedeUnattemptedInput(io:InputJournalPorts,surface:InputSurface,event:NativeEditEvidence,current:FrontendTableRead):number{
  const table=inputSurfaceState(io.state,surface);assertImmutableInputSlots(table.baseline,current,surface);
  if(![event.row,event.column,event.rows,event.columns].every(n=>Number.isSafeInteger(n)&&n>0)||event.rows*event.columns>250)fail('Invalid superseding edit range.');
  for(const entry of Object.values(io.journal.entries)){
    if(entry.edit.surface!==surface)continue;
    if(entry.superseded){cleanupSuperseded(io,entry);continue;}
    if(entry.commands.some(c=>c.attempted)||entry.edit.evidence.spreadsheetId!==event.spreadsheetId||entry.edit.evidence.sheetId!==event.sheetId)continue;
    const positions=entry.edit.drafts.map(d=>({draft:d,row:table.baseline.slots!.keys.indexOf(d.key)+3,column:current.headers.indexOf(d.header)+1}));
    if(!positions.length||positions.some(p=>p.row<3||p.column<1||p.row<event.row||p.row>=event.row+event.rows||p.column<event.column||p.column>=event.column+event.columns))continue;
    if(!positions.some(p=>inputCanonical(nativeInputValue(current.rows[p.row-3]?.[p.column-1]))!==inputCanonical(p.draft.value)))continue;
    entry.superseded=true;entry.issue='replaced-before-dispatch';io.saveJournal(io.journal);cleanupSuperseded(io,entry);
  }
  return Object.values(io.journal.entries).filter(e=>e.edit.surface===surface&&e.superseded).length;
}
export function deliverFrontendInputs(io:InputJournalPorts,limit=10):{attempted:number;committed:number}{
  if(!Number.isSafeInteger(limit)||limit<1||limit>25)fail('Input delivery exceeds its bounded batch.');
  let attempted=0,committed=0;
  for(const entry of Object.values(io.journal.entries)){
    if(entry.superseded){cleanupSuperseded(io,entry);continue;}
    if(entry.edit.status==='noop')continue;
    ensureHolds(io,entry);
    for(const delivery of entry.commands){
      if(delivery.status==='queued'&&attempted<limit){
        if(!delivery.attempted&&!io.stillVisible(entry.edit)){entry.issue='input-changed-before-dispatch';io.saveJournal(io.journal);continue;}
        delivery.attempted=true;io.saveJournal(io.journal);attempted++;
        let response:{status:number;body:unknown};
        try{response=io.send(entry.edit.templates[delivery.templateIndex].path,delivery.command);}catch{entry.issue='ambiguous-delivery';io.saveJournal(io.journal);continue;}
        if(response.status===200){
          // Validate before recording a successful delivery. A mismatched response cannot acknowledge the draft.
          try{const table=inputSurfaceState(io.state,entry.edit.surface);reconcileInputReceipt({...table,template:entry.edit.templates[delivery.templateIndex],command:delivery.command,receipt:response.body});}
          catch{entry.issue='ambiguous-receipt';io.saveJournal(io.journal);continue;}
          delivery.receipt=copy(response.body);delivery.status='committed';io.saveJournal(io.journal);
        }else if(response.status===409){delivery.status='conflict';entry.issue='version-conflict';io.saveJournal(io.journal);}
        else if([400,403,404,422].includes(response.status)){delivery.status='rejected';entry.issue='command-rejected';io.saveJournal(io.journal);}
        else{entry.issue='ambiguous-delivery';io.saveJournal(io.journal);}
      }
      if(delivery.status==='committed'&&!delivery.applied){
        const receiptHash=io.sha256(inputCanonical({command:delivery.command,receipt:delivery.receipt}));
        const old=io.state.inputReceipts?.[delivery.command.commandId];
        if(old&&old!==receiptHash)fail('The applied receipt marker changed.');
        if(!old){const table=inputSurfaceState(io.state,entry.edit.surface);table.set(reconcileInputReceipt({...table,template:entry.edit.templates[delivery.templateIndex],command:delivery.command,receipt:delivery.receipt}));
          io.state.inputReceipts??={};io.state.inputReceipts[delivery.command.commandId]=receiptHash;io.saveState(io.state);}
        delivery.applied=true;committed++;delete entry.issue;io.saveJournal(io.journal);
      }
    }
  }
  return {attempted,committed};
}
