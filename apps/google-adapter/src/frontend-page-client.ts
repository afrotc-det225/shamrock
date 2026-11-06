/** Read a complete coherent snapshot through bounded requests before exposing it to a writer. */
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
    const keys=effect?'claimToken,effectId,environment,generation,principalId,workerId':'environment,generation,principalId';
    if(!record(base)||Object.keys(base).sort().join(',')!==keys||base.environment!==config.environment||base.generation!==config.generation
      ||!id(base.principalId)||effect&&(!id(base.effectId)||!id(base.claimToken)||!id(base.workerId)))fail('The snapshot identity does not match its bound request.');
    const path=effect?'/v1/admin/effects/project/page':'/v1/admin/snapshot/page',start=nowSeconds();let count=0,total=0;
    if(!Number.isSafeInteger(start)||start<0)fail('The snapshot clock is invalid.');
    const before=()=>{const now=nowSeconds();if(!Number.isSafeInteger(now)||now<start||now-start>=FRONTEND_TRANSFER_LIMITS.seconds)fail('The coherent transfer exceeded its time budget; no partial snapshot was returned.');return now;};
    const page=(section:string,offset:number,rev:unknown):any=>{
      const timestamp=String(before());if(++count>FRONTEND_TRANSFER_LIMITS.pages)fail('The coherent transfer exceeded its page budget.');
      const body=JSON.stringify({...base,section,offset,revision:rev});
      const response=transport.send({method:'POST',url:config.baseUrl+path,body,headers:{'x-shamrock-key-id':config.keyId,'x-shamrock-timestamp':timestamp,
        'x-shamrock-signature':signer.hmacSha256(`POST\n${path}\n${timestamp}\n${signer.sha256(body)}`)}});
      before();
      if(response.status!==200)fail(`The coherent snapshot page did not complete (HTTP ${response.status}); retained work must retry without a partial snapshot.`);
      if(typeof response.body!=='string'||bytes(response.body)>FRONTEND_PAGE_MAX_BYTES)fail('A snapshot page exceeded its reviewed response bound.');
      total+=bytes(response.body);if(total>FRONTEND_TRANSFER_LIMITS.bytes)fail('The coherent transfer exceeded its total response bound.');
      let value:any;try{value=JSON.parse(response.body);}catch{return fail('A snapshot page was not valid JSON.');}
      if(!record(value)||value.contractVersion!==FRONTEND_PAGE_VERSION||value.section!==section||!revision(value.revision)
        ||rev!==null&&!sameRevision(value.revision,rev))fail('The snapshot revision or requested page changed during transfer.');
      return value;
    };
    const manifest=page('manifest',0,null) as FrontendPageManifest;
    if(manifest.environment!==base.environment||manifest.generation!==base.generation||!Array.isArray(manifest.sections)
      ||manifest.sections.length!==FRONTEND_SECTIONS.length||manifest.sections.some((s,i)=>!record(s)||s.section!==FRONTEND_SECTIONS[i]||!Number.isSafeInteger(s.count)||s.count<0||s.count>FRONTEND_SECTION_BOUNDS[s.section])
      ||!Array.isArray(manifest.diagnostics)||manifest.diagnostics.some(d=>!record(d)||typeof d.code!=='string'||!Number.isSafeInteger(d.count)||d.count<0)
      ||effect&&(!manifest.effect||manifest.effect.effectId!==base.effectId||!['frontend.refresh','forms.refresh'].includes(manifest.effect.kind))
      ||!effect&&manifest.effect!==undefined)fail('The coherent snapshot manifest does not match its request or capacity bounds.');
    const pages:FrontendDataPage[]=[];
    for(const section of manifest.sections){let offset=0;
      do{const next=page(section.section,offset,manifest.revision) as FrontendDataPage;
        if(next.offset!==offset||!Array.isArray(next.rows)||next.rows.some(r=>!record(r))||next.rows.length>512||offset+next.rows.length>section.count
          ||next.rows.length===0&&section.count!==0||next.nextOffset!==(offset+next.rows.length<section.count?offset+next.rows.length:null))fail('A snapshot page was missing, repeated or incomplete.');
        pages.push(next);offset+=next.rows.length;
      }while(offset<section.count);
    }
    const verify=page('verify',0,manifest.revision) as FrontendVerifyPage;
    let snapshot;try{snapshot=assembleFrontendSnapshotPages(manifest,pages,verify);}catch{return fail('The complete snapshot failed final coherence verification.');}
    before();const body=JSON.stringify(effect?{effect:manifest.effect,snapshot}:snapshot);
    if(bytes(body)>FRONTEND_TRANSFER_LIMITS.bytes)fail('The assembled snapshot exceeded its reviewed bound.');
    return{status:200,body};
  }};
}
