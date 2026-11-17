/** Read a complete coherent snapshot through bounded requests before exposing it to a writer. */
import {summarizeNativeTerm,type FrontendDashboardSnapshot} from './frontend-history-summary.js';
import {AdapterError,type AdapterConfig,type Signer,type Transport} from './index.js';
import {assembleFrontendSnapshotPages,FRONTEND_PAGE_VERSION,FRONTEND_PAGE_MAX_BYTES,FRONTEND_SECTIONS,FRONTEND_SECTION_BOUNDS,
  type FrontendPageManifest,type FrontendDataPage,type FrontendVerifyPage} from '../../../packages/domain/src/frontend-transport.js';

export const FRONTEND_TRANSFER_LIMITS={pages:512,bytes:5*1024*1024,seconds:120} as const;
function fail(message:string):never{throw new AdapterError('frontend_pages',message);}
const bytes=(text:string)=>encodeURIComponent(text).replace(/%[A-F0-9]{2}/g,'x').length;
const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const record=(value:unknown):value is Record<string,any>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const revision=(value:any)=>record(value)&&Object.keys(value).sort().join(',')==='administration,operations'&&Object.values(value).every(v=>Number.isSafeInteger(v)&&Number(v)>=0);
const sameRevision=(a:any,b:any)=>revision(a)&&revision(b)&&a.operations===b.operations&&a.administration===b.administration;

/** Only the two read paths are substituted. Commands, claims and receipts retain their exact transport. */
export function createPagedFrontendTransport(transport:Transport,config:AdapterConfig,signer:Signer,nowSeconds:()=>number):Transport{
  return{send(original){
    const effect=original.url===config.baseUrl+'/v1/admin/effects/project';
    if(!effect&&original.url!==config.baseUrl+'/v1/admin/snapshot')return transport.send(original);
    if(original.method!=='POST'||!/^https:\/\/[A-Za-z0-9.-]+$/.test(config.baseUrl)||!id(config.keyId)||!Number.isSafeInteger(config.generation)||config.generation<1)fail('The paged transport configuration is invalid.');
    let base:any;try{base=JSON.parse(original.body);}catch{return fail('The snapshot request is invalid.');}
    const keys=effect?'claimToken,effectId,environment,generation,principalId,workerId':Object.hasOwn(base??{},'termId')?'environment,generation,principalId,termId':'environment,generation,principalId';
    if(!record(base)||Object.keys(base).sort().join(',')!==keys||base.environment!==config.environment||base.generation!==config.generation
      ||!id(base.principalId)||!effect&&base.termId!=null&&!id(base.termId)||effect&&(!id(base.effectId)||!id(base.claimToken)||!id(base.workerId)))fail('The snapshot identity does not match its bound request.');
    const path=effect?'/v1/admin/effects/project/page':'/v1/admin/snapshot/page',start=nowSeconds();let count=0,total=0;
    if(!Number.isSafeInteger(start)||start<0)fail('The snapshot clock is invalid.');
    const before=()=>{const now=nowSeconds();if(!Number.isSafeInteger(now)||now<start||now-start>=FRONTEND_TRANSFER_LIMITS.seconds)fail('The coherent transfer exceeded its time budget; no partial snapshot was returned.');return now;};
    const page=(section:string,offset:number,rev:unknown,requestBase=base,requestPath=path):any=>{
      const timestamp=String(before());if(++count>FRONTEND_TRANSFER_LIMITS.pages)fail('The coherent transfer exceeded its page budget.');
      const body=JSON.stringify({...requestBase,section,offset,revision:rev});
      const response=transport.send({method:'POST',url:config.baseUrl+requestPath,body,headers:{'x-shamrock-key-id':config.keyId,'x-shamrock-timestamp':timestamp,
        'x-shamrock-signature':signer.hmacSha256(`POST\n${requestPath}\n${timestamp}\n${signer.sha256(body)}`)}});
      before();
      if(response.status!==200)fail(`The coherent snapshot page did not complete (HTTP ${response.status}); retained work must retry without a partial snapshot.`);
      if(typeof response.body!=='string'||bytes(response.body)>FRONTEND_PAGE_MAX_BYTES)fail('A snapshot page exceeded its reviewed response bound.');
      total+=bytes(response.body);if(total>FRONTEND_TRANSFER_LIMITS.bytes)fail('The coherent transfer exceeded its total response bound.');
      let value:any;try{value=JSON.parse(response.body);}catch{return fail('A snapshot page was not valid JSON.');}
      if(!record(value)||value.contractVersion!==FRONTEND_PAGE_VERSION||value.section!==section||!revision(value.revision)
        ||rev!==null&&!sameRevision(value.revision,rev))fail('The snapshot revision or requested page changed during transfer.');
      return value;
    };
    const read=(requestBase:any,requestPath:string,isEffect:boolean,expectedRevision?:unknown)=>{
      const fetchPage=(section:string,offset:number,rev:unknown)=>page(section,offset,rev,requestBase,requestPath);
      const manifest=fetchPage('manifest',0,null) as FrontendPageManifest;
      if(manifest.environment!==base.environment||manifest.generation!==base.generation||!Array.isArray(manifest.sections)
        ||manifest.sections.length!==FRONTEND_SECTIONS.length||manifest.sections.some((s,i)=>!record(s)||s.section!==FRONTEND_SECTIONS[i]||!Number.isSafeInteger(s.count)||s.count<0||s.count>FRONTEND_SECTION_BOUNDS[s.section])
        ||!Array.isArray(manifest.diagnostics)||manifest.diagnostics.some(d=>!record(d)||typeof d.code!=='string'||!Number.isSafeInteger(d.count)||d.count<0)
        ||isEffect&&(!manifest.effect||manifest.effect.effectId!==base.effectId||!['frontend.refresh','forms.refresh'].includes(manifest.effect.kind))
        ||!isEffect&&manifest.effect!==undefined||expectedRevision!==undefined&&!sameRevision(manifest.revision,expectedRevision))fail('The coherent snapshot manifest does not match its request or capacity bounds.');
      if(manifest.scope&&(!id(manifest.scope.termId)||!id(manifest.scope.currentTermId)||manifest.scope.termId!==(requestBase.termId??manifest.scope.currentTermId)))fail('The snapshot semester does not match its request.');
      const pages:FrontendDataPage[]=[];
      for(const section of manifest.sections){let offset=0;
        do{const next=fetchPage(section.section,offset,manifest.revision) as FrontendDataPage;
          if(next.offset!==offset||!Array.isArray(next.rows)||next.rows.some(r=>!record(r))||next.rows.length>512||offset+next.rows.length>section.count
            ||next.rows.length===0&&section.count!==0||next.nextOffset!==(offset+next.rows.length<section.count?offset+next.rows.length:null))fail('A snapshot page was missing, repeated or incomplete.');
          pages.push(next);offset+=next.rows.length;
        }while(offset<section.count);
      }
      const verify=fetchPage('verify',0,manifest.revision) as FrontendVerifyPage;
      try{return{manifest,snapshot:assembleFrontendSnapshotPages(manifest,pages,verify) as FrontendDashboardSnapshot};}catch{return fail('The complete snapshot failed final coherence verification.');}
    };
    const {manifest,snapshot}=read(base,path,effect);
    if(effect&&manifest.effect?.kind==='frontend.refresh'&&manifest.scope){
      if(!Array.isArray(manifest.previousTerms)||manifest.previousTerms.length>2||new Set(manifest.previousTerms.map(t=>t.termId)).size!==manifest.previousTerms.length)fail('The Dashboard comparison catalog is incomplete.');
      const current=snapshot.terms.find(t=>t.isCurrent);
      if(!current||current.termId!==manifest.scope.currentTermId||manifest.previousTerms.some(t=>!id(t.termId)||typeof t.label!=='string'||!Number.isSafeInteger(t.sortOrder)||t.sortOrder>=current.sortOrder))fail('The Dashboard comparison catalog is invalid.');
      const summaries=manifest.previousTerms.map(term=>{
        const historical=read({environment:base.environment,generation:base.generation,principalId:base.principalId,termId:term.termId},'/v1/admin/snapshot/page',false,manifest.revision);
        if(historical.manifest.scope?.currentTermId!==current.termId||historical.manifest.scope.termId!==term.termId)fail('The Dashboard semester changed during transfer.');
        const summary=summarizeNativeTerm(historical.snapshot,term.termId);
        if(summary.sortOrder!==term.sortOrder||summary.label!==term.label)fail('The Dashboard term metadata changed during transfer.');
        return summary;
      });
      // Historical reads use ordinary read authority; recheck the effect lease after all comparisons.
      const final=page('verify',0,manifest.revision) as FrontendVerifyPage;
      if(final.verified!==true||JSON.stringify(final.effect)!==JSON.stringify(manifest.effect)||JSON.stringify(final.scope)!==JSON.stringify(manifest.scope))fail('The final Dashboard verification changed during transfer.');
      snapshot.dashboardHistory={revision:manifest.revision,currentTermId:current.termId,terms:summaries};
    }
    before();const body=JSON.stringify(effect?{effect:manifest.effect,snapshot}:snapshot);
    if(bytes(body)>FRONTEND_TRANSFER_LIMITS.bytes)fail('The assembled snapshot exceeded its reviewed bound.');
    return{status:200,body};
  }};
}
