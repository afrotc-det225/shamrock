import {AdapterError,type Signer} from './index.js';
import {createPrivateCheckpoint} from './private-checkpoint.js';
import {createPrivateRetention,combineRetentionVolumes,retentionCanonical,type RetentionIndex,type RetentionStore} from './private-retention.js';
export interface NativeRetentionConfig {version:1;archiveFolderId:string;indexFileId:string;previous?:{version:1;archiveFolderId:string;indexFileId:string}[]}
export interface NativeRetentionServices {ScriptApp:{getOAuthToken():string};UrlFetchApp:{fetch(url:string,options:any):{getResponseCode():number;getContentText():string}}}
const bytes=(s:string)=>encodeURIComponent(s).replace(/%[A-F0-9]{2}/g,'x').length;
function fail(message:string):never{throw new AdapterError('retention_provider',message);}
/** File IDs/config are provider-owned. Metadata names contain no cadet/response identifiers. */
export function createNativeRetention(services:NativeRetentionServices,config:NativeRetentionConfig,owner:string,generation:number,signer:Signer):RetentionStore{
  if(config.previous!==undefined){if(!Array.isArray(config.previous)||config.previous.length>4||new Set([config.indexFileId,...config.previous.map(v=>v.indexFileId)]).size!==config.previous.length+1)fail('The reviewed archive volume chain is invalid.');
    const{previous,...current}=config;return combineRetentionVolumes(createNativeRetention(services,current,owner,generation,signer),previous.map(v=>createNativeRetention(services,v,owner,generation,signer)));}
  if(config.version!==1||![config.archiveFolderId,config.indexFileId].every(id=>/^[A-Za-z0-9_-]{1,512}$/.test(id))||config.archiveFolderId===config.indexFileId)fail('A reviewed private archive folder and index are required.');
  const base='https://www.googleapis.com/drive/v3/files/',cache=new Map<string,string>();let folderChecked=false;
  function call(url:string,method='get',payload?:string,contentType='application/json'){
    const result=services.UrlFetchApp.fetch(url,{method,headers:{Authorization:`Bearer ${services.ScriptApp.getOAuthToken()}`},...(payload!==undefined?{payload,contentType}:{}),muteHttpExceptions:true,followRedirects:false,validateHttpsCertificates:true});
    const text=result.getContentText();if(bytes(text)>2_000_000)fail('A private archive response exceeded its bound.');return{status:result.getResponseCode(),text};
  }
  function metadata(id:string,missing=false){const r=call(base+encodeURIComponent(id)+'?fields=id,mimeType,size,version,trashed,parents,owners(emailAddress),permissions(type,role,emailAddress,deleted)');if(missing&&r.status===404)return null;if(r.status!==200)fail(`Private archive metadata did not verify (HTTP ${r.status}).`);
    const m=JSON.parse(r.text);if(m.id!==id||m.trashed||m.owners?.length!==1||m.owners[0].emailAddress!==owner||m.permissions?.length!==1
      ||m.permissions[0].type!=='user'||m.permissions[0].role!=='owner'||m.permissions[0].emailAddress!==owner||m.permissions[0].deleted)fail('The archive must remain owned and readable only by the configured automation account.');
    if(id===config.archiveFolderId){if(m.mimeType!=='application/vnd.google-apps.folder')fail('The private archive binding is not a folder.');}
    else if(m.mimeType!=='application/json'||m.parents?.length!==1||m.parents[0]!==config.archiveFolderId||!Number.isSafeInteger(Number(m.size))||Number(m.size)>2_000_000)fail('The archived file moved, changed type or exceeded its bound.');return m;
  }
  function folder(){if(!folderChecked){metadata(config.archiveFolderId);folderChecked=true;}}
  function read(id:string,fresh=false):string|null{folder();if(!fresh&&cache.has(id))return cache.get(id)!;if(!metadata(id,true))return null;const r=call(base+encodeURIComponent(id)+'?alt=media');if(r.status!==200)fail(`Private archive content did not load (HTTP ${r.status}).`);cache.set(id,r.text);return r.text;}
  function replace(id:string,before:string,after:string){if(read(id,true)!==before)fail('The private archive index changed outside the shared lock.');
    const r=call(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&fields=id`,'patch',after);cache.delete(id);if(r.status!==200||read(id,true)!==after)fail('The private archive index update did not verify.');}
  const root=createPrivateCheckpoint<RetentionIndex>({version:()=>String(metadata(config.indexFileId).version),read:()=>{const text=read(config.indexFileId,true);if(text===null)fail('Provision the private archive index before enabling retention.');return JSON.parse(text);},validate:value=>{
    const r=value as RetentionIndex;if(!r||r.version!==1||r.environment!=='staging'||r.generation!==generation||!r.buckets||bytes(retentionCanonical(r))>2_000_000)fail('The archive index has another generation or invalid content.');return r;},digest:v=>signer.sha256(retentionCanonical(v)),write:value=>{
    const r=call(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(config.indexFileId)}?uploadType=media&fields=id`,'patch',retentionCanonical(value));cache.delete(config.indexFileId);if(r.status!==200)fail('The private archive index did not persist.');}});
  return createPrivateRetention({generation,sha256:signer.sha256,root,read,
    reserveIds(count){folder();const r=call(base+`generateIds?count=${count}&space=drive&type=files`);if(r.status!==200)fail('Private archive IDs could not be reserved.');const ids=JSON.parse(r.text).ids;if(!Array.isArray(ids)||ids.length!==count||ids.some((x:unknown)=>typeof x!=='string'||!/^[A-Za-z0-9_-]+$/.test(x)))fail('The reserved archive IDs are invalid.');return ids;},
    replaceIndex:replace,
    create(id,text,label){folder();const prior=read(id,true);if(prior!==null){if(prior!==text)fail('A reserved archive file already contains different evidence.');return;}
      const boundary='shamrock_'+signer.sha256(id+text),meta=JSON.stringify({id,name:label,mimeType:'application/json',parents:[config.archiveFolderId]});
      const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
      const r=call('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id','post',body,`multipart/related; boundary=${boundary}`);cache.delete(id);
      // An ambiguous creation can only succeed by exact readback at the already reserved ID.
      if(![200,201,409].includes(r.status)||read(id,true)!==text)fail('The reserved archive object did not verify; retry the same saved ID.');
    }});
}
