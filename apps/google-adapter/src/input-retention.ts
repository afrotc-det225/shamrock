import {AdapterError} from './index.js';
import {inputCanonical} from './frontend-input.js';
import type {InputJournalPorts,InputJournalEntry} from './frontend-input-journal.js';
import type {RetentionStore} from './private-retention.js';
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function fail(message:string):never{throw new AdapterError('input_retention',message);}
export function archivedInputReceipt(store:RetentionStore,commandId:string):string|undefined{
  const value=store.get(`input-receipt.${commandId}`) as {commandId:string;hash:string}|undefined;
  if(value&&(value.commandId!==commandId||! /^[a-f0-9]{64}$/.test(value.hash)))fail('Archived receipt identity changed.');return value?.hash;
}
export function archivedInputEntry(store:RetentionStore,editId:string):InputJournalEntry|undefined{
  const entry=store.get(`input-entry.${editId}`) as InputJournalEntry|undefined;
  if(entry&&(entry.edit.editId!==editId||!terminal(entry)))fail('An archived input is not a verified terminal record.');return entry;
}
function terminal(e:InputJournalEntry){return e.superseded?e.supersededApplied===true&&e.commands.every(c=>!c.attempted)
  :e.commands.length>0&&e.noteStatus==='committed'&&e.commands.every(c=>c.status==='committed'&&c.applied===true&&c.receipt!==undefined);}
/** Archive before active removal, journal removal before receipt pruning; every interrupted prefix is recoverable. */
export function compactInputJournal(io:InputJournalPorts,store:RetentionStore,retain=32,limit=32):number{
  const entries=Object.entries(io.journal.entries),activeCommands=new Set(entries.flatMap(([,e])=>e.commands.map(c=>c.command.commandId)));
  const orphaned=Object.keys(io.state.inputReceipts??{}).some(id=>!activeCommands.has(id));
  if(!orphaned&&entries.length<=128&&inputCanonical(io.journal).length<512000&&Object.keys(io.state.inputReceipts??{}).length<2048)return 0;
  const completed=entries.filter(([,e])=>terminal(e)),selected=completed.slice(0,Math.max(0,completed.length-retain)).slice(0,limit);
  const records:{key:string;value:unknown}[]=[];
  for(const[id,e]of selected){records.push({key:`input-entry.${id}`,value:e});for(const d of e.commands){if(e.superseded)continue;
      const hash=io.sha256(inputCanonical({command:d.command,receipt:d.receipt})),active=io.state.inputReceipts?.[d.command.commandId],old=archivedInputReceipt(store,d.command.commandId);
      if((active??old)!==hash)fail('Archive only receipts already verified and applied to the exact frontend baseline.');records.push({key:`input-receipt.${d.command.commandId}`,value:{commandId:d.command.commandId,hash}});
  }}
  if(records.length)store.put(records);
  const next=copy(io.journal);
  for(const[id,e]of selected){if(inputCanonical(archivedInputEntry(store,id))!==inputCanonical(e))fail('The completed input archive did not verify.');delete next.entries[id];
    if(e.superseded){next.supersededCounts??={};next.supersededCounts[e.edit.surface]=(next.supersededCounts[e.edit.surface]??0)+1;}}
  if(selected.length){io.saveJournal(next);io.journal=next;}
  // Also finish pruning markers when a prior invocation removed the journal entry but stopped before this save.
  let changed=false,pruned=0;const state=copy(io.state);
  for(const[commandId,hash]of Object.entries(state.inputReceipts??{})){if(pruned>=limit)break;
    if(Object.values(io.journal.entries).some(e=>e.commands.some(c=>c.command.commandId===commandId)))continue;
    const archived=archivedInputReceipt(store,commandId);if(archived===undefined)continue;if(archived!==hash)fail('Archived receipt marker differs from the applied marker.');delete state.inputReceipts![commandId];changed=true;pruned++;
  }
  if(changed){io.saveState(state);Object.assign(io.state,state);}return selected.length;
}
