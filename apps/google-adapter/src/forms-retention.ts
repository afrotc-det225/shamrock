import {AdapterError,type Signer} from './index.js';
import type {FormEdition} from './forms-publication.js';
import type {FormsState} from './forms-refresh.js';
import type {FormIntakeBinding,VerifiedFormSubmission} from './forms-intake.js';
import {retentionCanonical,type RetentionStore} from './private-retention.js';
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function fail(message:string):never{throw new AdapterError('forms_retention',message);}
export function createFormCatalogArchive(store:RetentionStore,signer:Signer){
  const tokenKey=(formId:string,token:string)=>`form-token.${signer.sha256(formId)}.${token}`;
  function load(editionId:string):FormEdition|undefined{const stored=store.get(`form-edition.${editionId}`) as (FormEdition&{retentionVersion:1;peopleBlocks:string[];referenceBlocks:string[]})|undefined;if(!stored)return;
    if(stored.retentionVersion!==1||stored.editionId!==editionId||stored.people.length||!Array.isArray(stored.peopleBlocks)||stored.peopleBlocks.length>16)fail('The historical Form catalog is invalid.');
    const {retentionVersion:_version,peopleBlocks,referenceBlocks,...edition}=stored;for(const key of peopleBlocks){const block=store.get(key) as {kind:string;people:FormEdition['people']}|undefined;if(!block||block.kind!=='form-people'||!Array.isArray(block.people)||block.people.length>32||`form-people.${signer.sha256(retentionCanonical(block))}`!==key)fail('A frozen Directory profile block is missing or changed.');edition.people.push(...copy(block.people));}
    if(!Array.isArray(referenceBlocks)||referenceBlocks.length>300||Object.keys(edition.references).length)fail('The historical reference manifest is invalid.');
    for(const key of referenceBlocks){const block=store.get(key) as {kind:string;references:FormEdition['references']}|undefined;if(!block||block.kind!=='form-references'||!block.references||`form-references.${signer.sha256(retentionCanonical(block))}`!==key||Object.keys(block.references).some(k=>edition.references[k]))fail('A frozen Form reference block is missing or changed.');Object.assign(edition.references,block.references);}
    return edition;
  }
  function save(edition:FormEdition){const previous=load(edition.editionId);if(previous&&retentionCanonical(previous)!==retentionCanonical({...edition,revision:previous.revision}))fail('A historical Form edition cannot change.');
    const value=previous??edition,blocks:{key:string;value:unknown}[]=[],peopleBlocks:string[]=[],referenceBlocks:string[]=[];
    for(let i=0;i<value.people.length;i+=32){const block={kind:'form-people',people:copy(value.people.slice(i,i+32))},key=`form-people.${signer.sha256(retentionCanonical(block))}`;blocks.push({key,value:block});peopleBlocks.push(key);}
    const refs=Object.entries(value.references);for(let i=0;i<refs.length;i+=256){const block={kind:'form-references',references:Object.fromEntries(refs.slice(i,i+256))},key=`form-references.${signer.sha256(retentionCanonical(block))}`;blocks.push({key,value:block});referenceBlocks.push(key);}
    const tokens=Object.keys(value.references).map(token=>({key:tokenKey(value.formId,token),value:{editionId:value.editionId,formId:value.formId,generation:value.generation}}));
    // Immutable token records detect collisions against every archived edition before publication.
    const records=blocks.filter((b,i)=>blocks.findIndex(x=>x.key===b.key)===i);for(let i=0;i<records.length;i+=1000)store.put(records.slice(i,i+1000));
    store.put([{key:`form-edition.${value.editionId}`,value:{...copy(value),people:[],references:{},retentionVersion:1,peopleBlocks,referenceBlocks}}]);
    for(let i=0;i<tokens.length;i+=1000)store.put(tokens.slice(i,i+1000));
    if(retentionCanonical(load(value.editionId))!==retentionCanonical(value))fail('The archived Form edition did not read back exactly.');
  }
  return{load,save,
    retain(state:FormsState,incoming:FormEdition[]):Record<string,FormEdition>{
      for(const edition of Object.values(state.editions))save(edition);for(const edition of incoming)save(edition);
      const keep=new Set([...Object.values(state.current),...incoming.map(e=>e.editionId)]);return Object.fromEntries([...keep].map(id=>[id,load(id)??fail('A current edition is unavailable after archival.')]));
    },
    forSubmission(state:FormsState,submission:VerifiedFormSubmission,binding:FormIntakeBinding){const result=copy(state.editions),questions=binding.kind==='directory'?Object.values(binding.directoryFields??{}):binding.events??[];
      for(const question of questions){const answer=submission.answers[question];for(const label of typeof answer==='string'?[answer]:answer??[]){const token=/\[sr:([a-f0-9]{12})\]$/.exec(label)?.[1];if(!token)continue;
          const active=Object.values(result).filter(e=>e.formId===submission.formId&&e.references[token]);if(active.length>1)fail('An active Form reference is ambiguous.');if(active.length)continue;
          const link=store.get(tokenKey(submission.formId,token)) as {editionId:string;formId:string;generation:number}|undefined;
          if(!link||link.formId!==submission.formId||link.generation!==state.generation)fail('The original Form reference is unavailable; preserve the response for review.');
          const edition=load(link.editionId);if(!edition||edition.formId!==link.formId||!edition.references[token])fail('The archived Form reference changed.');result[edition.editionId]=edition;
      }}return result;
    }};
}
/** Archive only completely acknowledged Forms intake. Pending/conflicted/rejected evidence stays active. */
export function compactFormsIntake<T extends {entries:Record<string,any>}>(state:T,store:RetentionStore,retain=32,limit=32):{state:T;archived:number}{
  const entries=Object.entries(state.entries);if(entries.length<=128&&retentionCanonical(state).length<512_000)return{state,archived:0};
  const candidates=entries.filter(([,e])=>e.status==='committed'&&Array.isArray(e.commands)&&e.commands.every((c:any)=>c.status==='committed'&&c.receipt));
  const selected=candidates.slice(0,Math.max(0,candidates.length-retain)).slice(0,limit);if(!selected.length)return{state,archived:0};
  store.put(selected.map(([id,value])=>({key:`form-intake.${id}`,value})));const next=copy(state);
  for(const[id,value]of selected){if(retentionCanonical(store.get(`form-intake.${id}`))!==retentionCanonical(value))fail('Completed intake evidence did not verify.');delete next.entries[id];}
  return{state:next,archived:selected.length};
}
