/** Private configuration cache scoped to one synchronous scheduled invocation only.
 * State, Sheets, Forms and Worker responses are never cached. Google writes invalidate it. */
import {CONFIG_FILE_ID_PROPERTY} from './staging-config.js';
interface ResponsePort {getResponseCode():number;getContentText():string}
interface FetchPort {fetch(url:string,options:Record<string,unknown>):ResponsePort}
export function createInvocationConfigFetch(fetcher:FetchPort,rootFileId:string|null):FetchPort{
  const ids=new Set(rootFileId?[rootFileId]:[]),cache=new Map<string,ResponsePort>();
  const fields='id,name,mimeType,size,version,trashed,driveId,owners(emailAddress),permissions(type,role,emailAddress,deleted)';
  return{fetch(url,options){
    const method=String(options.method??'get').toLowerCase();
    if(method!=='get'){if(/^https:\/\/(?:www\.googleapis\.com|sheets\.googleapis\.com|forms\.googleapis\.com)\//.test(url))cache.clear();return fetcher.fetch(url,options);}
    const match=/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([A-Za-z0-9_-]+)(\/permissions)?\?(.+)$/.exec(url);
    if(!match||!ids.has(match[1]))return fetcher.fetch(url,options);
    const media=/(?:^|&)alt=media(?:&|$)/.test(match[3]),metadata=!match[2]&&!media;
    const key=metadata?`metadata:${match[1]}`:url;
    if(cache.has(key))return cache.get(key)!;
    const response=fetcher.fetch(metadata?`https://www.googleapis.com/drive/v3/files/${match[1]}?fields=${encodeURIComponent(fields)}`:url,options);
    if(response.getResponseCode()!==200)return response;
    const text=response.getContentText();if(text.length>1_000_000)return response;
    const frozen={getResponseCode:()=>200,getContentText:()=>text};cache.set(key,frozen);
    if(media&&match[1]===rootFileId){
      try{const root=JSON.parse(text);for(const property of ['SHAMROCK_V3_FORMS_CONFIG','SHAMROCK_V3_INPUT_CONFIG','SHAMROCK_V3_PERMISSION_CONFIG']){
        const value=typeof root[property]==='string'?JSON.parse(root[property]):root[property];
        if(value?.version===1&&typeof value.configFileId==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(value.configFileId))ids.add(value.configFileId);
      }}catch{/* The owning configuration parser reports malformed content. */}
    }
    return frozen;
  }};
}
export function invocationServices<T extends {PropertiesService:{getScriptProperties():{getProperty(key:string):string|null}};UrlFetchApp:FetchPort}>(services:T):T{
  return {...services,UrlFetchApp:createInvocationConfigFetch(services.UrlFetchApp,services.PropertiesService.getScriptProperties().getProperty(CONFIG_FILE_ID_PROPERTY))};
}
