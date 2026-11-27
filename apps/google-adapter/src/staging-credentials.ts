/** One-time owner-private delivery into Script Properties; never store keys in source or config. */
import { AdapterError } from './index.js';
import { HOST_PROPERTIES, parseStagingHostConfig } from './staging-host.js';
import { CONFIG_FILE_ID_PROPERTY } from './staging-config.js';
import type { UtilitiesPort } from './apps-script.js';
export const CREDENTIAL_IMPORT_PROPERTY='SHAMROCK_V3_CREDENTIAL_IMPORT';
const RECEIPT='SHAMROCK_V3_CREDENTIAL_IMPORT_RECEIPT';
export interface StagingCredentialServices {
  Utilities:Pick<UtilitiesPort,'DigestAlgorithm'|'Charset'|'computeDigest'>;
  PropertiesService:{getScriptProperties():{getProperty(key:string):string|null;setProperty(key:string,value:string):unknown}};
  Session:{getEffectiveUser():{getEmail():string};getActiveUser():{getEmail():string}};
  ScriptApp:{getOAuthToken():string};LockService:{getScriptLock():{tryLock(ms:number):boolean;releaseLock():void}};
  UrlFetchApp:{fetch(url:string,options:{method:'get'|'patch';headers:Record<string,string>;contentType?:string;payload?:string;muteHttpExceptions:true;followRedirects:false;validateHttpsCertificates:true}):{getResponseCode():number;getContentText():string}};
}
function fail():never{throw new AdapterError('staging_credential_import','The private credential delivery could not be verified. Synchronization remains paused.');}
const fileId=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(v);
const exact=(v:object,fields:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===fields.sort().join(',');
export function importStagingCredential(s:StagingCredentialServices,nowSeconds=()=>Math.floor(Date.now()/1000)) {
  const p=s.PropertiesService.getScriptProperties(),lock=s.LockService.getScriptLock();if(!lock.tryLock(1000))fail();
  try {
    const gates={SHAMROCK_V3_ENABLED:'false',SHAMROCK_V3_FRONTEND_PAUSED:'true',SHAMROCK_V3_MAINTENANCE_PAUSED:'true',SHAMROCK_V3_FORMS_PAUSED:'true',SHAMROCK_V3_FORM_INTAKE_PAUSED:'true',SHAMROCK_V3_INPUT_PAUSED:'true',SHAMROCK_V3_PERMISSION_PAUSED:'true',SHAMROCK_V3_OWNER_MAIL_PAUSED:'true',SHAMROCK_V3_HISTORY_PAUSED:'true'};
    for(const[k,v]of Object.entries(gates))p.setProperty(k,v);if(Object.entries(gates).some(([k,v])=>p.getProperty(k)!==v))fail();
    const host=parseStagingHostConfig(JSON.parse(p.getProperty(HOST_PROPERTIES.config)??'null')),owner=host.expectedAutomationEmail;
    if(s.Session.getEffectiveUser().getEmail().trim().toLowerCase()!==owner||s.Session.getActiveUser().getEmail().trim().toLowerCase()!==owner)fail();
    const rootId=p.getProperty(CONFIG_FILE_ID_PROPERTY);if(!fileId(rootId))fail();
    const api=(url:string,body?:unknown):any=>{const r=s.UrlFetchApp.fetch(url,{method:body===undefined?'get':'patch',headers:{Authorization:`Bearer ${s.ScriptApp.getOAuthToken()}`},...(body===undefined?{}:{contentType:'application/json',payload:JSON.stringify(body)}),muteHttpExceptions:true,followRedirects:false,validateHttpsCertificates:true});const text=r.getContentText();if(r.getResponseCode()!==200||text.length>65536)fail();try{return JSON.parse(text);}catch{return fail();}};
    const url=(id:string)=>`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`;
    const inspect=(id:string,limit:number,allowTrashed=false)=>{const m=api(`${url(id)}?fields=id,mimeType,size,version,trashed,driveId,owners(emailAddress),permissions(type,role,emailAddress,deleted)`);
      if(m.id!==id||m.driveId||m.trashed&&!allowTrashed||m.mimeType!=='application/json'||!Number.isSafeInteger(Number(m.size))||Number(m.size)<1||Number(m.size)>limit||m.owners?.length!==1||m.owners[0].emailAddress!==owner||m.permissions?.length!==1||m.permissions[0].type!=='user'||m.permissions[0].role!=='owner'||m.permissions[0].deleted||m.permissions[0].emailAddress!==owner)fail();return m;};
    const rootMeta=inspect(rootId!,65536),root=api(`${url(rootId!)}?alt=media`),pointer=JSON.parse(root[CREDENTIAL_IMPORT_PROPERTY]??'null');
    if(!exact(pointer,['version','fileId','requestId','sequence'])||pointer.version!==1||!fileId(pointer.fileId)||pointer.fileId===rootId||typeof pointer.requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(pointer.requestId)||!Number.isSafeInteger(pointer.sequence)||pointer.sequence<1)fail();
    const digest=(value:string)=>s.Utilities.computeDigest(s.Utilities.DigestAlgorithm.SHA_256,value,s.Utilities.Charset.UTF_8).map(b=>(b&255).toString(16).padStart(2,'0')).join('');
    const currentBinding=(targetProperty:string)=>{
      if(targetProperty===HOST_PROPERTIES.secret)return {targetProperty,workerOrigin:host.workerOrigin,keyId:host.keyId};
      const history=JSON.parse(root.SHAMROCK_V3_HISTORY_CONFIG??'null');if(!history?.api||!/^SHAMROCK_V3_HISTORY_[A-Z0-9_]{1,80}_SECRET$/.test(history.api.secretProperty)||targetProperty!==history.api.secretProperty)fail();
      return {targetProperty,workerOrigin:history.api.baseUrl,keyId:history.api.keyId};
    };
    const prior=JSON.parse(p.getProperty(RECEIPT)??'null');
    if(prior&&JSON.stringify(prior.pointer)===JSON.stringify(pointer)){
      const binding=currentBinding(prior.binding?.targetProperty),installed=p.getProperty(binding.targetProperty);
      if(!installed||Object.entries(binding).some(([k,v])=>prior.binding[k]!==v)||digest(installed)!==prior.secretDigest||inspect(rootId!,65536).version!==rootMeta.version)fail();
      const m=inspect(pointer.fileId,4096,true);if(!m.trashed)api(`${url(pointer.fileId)}?fields=id,trashed`,{trashed:true});
      if(!inspect(pointer.fileId,4096,true).trashed)fail();return {status:'already-imported-paused'};
    }
    if(prior&&(prior.pointer.sequence>=pointer.sequence||prior.pointer.requestId===pointer.requestId))fail();
    const meta=inspect(pointer.fileId,4096),delivery=api(`${url(pointer.fileId)}?alt=media`);
    if(!exact(delivery,['version','environment','generation','requestId','targetProperty','workerOrigin','keyId','secret','expiresAt'])||delivery.version!==1||delivery.environment!=='staging'||delivery.generation!==host.generation||delivery.requestId!==pointer.requestId||typeof delivery.secret!=='string'||!/^[A-Za-z0-9_+\/=.-]{32,256}$/.test(delivery.secret)||!Number.isSafeInteger(delivery.expiresAt)||delivery.expiresAt<=nowSeconds()||delivery.expiresAt>nowSeconds()+3600)fail();
    const binding=currentBinding(delivery.targetProperty);
    if(Object.entries(binding).some(([k,v])=>delivery[k]!==v)||inspect(pointer.fileId,4096).version!==meta.version||inspect(rootId!,65536).version!==rootMeta.version)fail();
    p.setProperty(binding.targetProperty,delivery.secret);if(p.getProperty(binding.targetProperty)!==delivery.secret)fail();
    const receipt=JSON.stringify({pointer,binding,secretDigest:digest(delivery.secret)});p.setProperty(RECEIPT,receipt);if(p.getProperty(RECEIPT)!==receipt)fail();
    api(`${url(pointer.fileId)}?fields=id,trashed`,{trashed:true});if(!inspect(pointer.fileId,4096,true).trashed)fail();
    return {status:'imported-paused'};
  } finally {lock.releaseLock();}
}
