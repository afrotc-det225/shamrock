import { createNativePermissionRuntime } from './permissions-host.js';
import { PERMISSION_FENCE_PROPERTY } from './permissions-refresh.js';
/** One cheap five-minute poll; full reconciliation and slower maintenance have explicit cadences. */
import {AdapterError} from './index.js';
import {createGoogleSigner} from './apps-script.js';
import {HOST_PROPERTIES,parseStagingHostConfig} from './staging-host.js';
import {createNativeStagingHost} from './native-runtime.js';
import {createNativeFrontendRuntime} from './frontend-runtime.js';
import {createNativeFormsRuntime} from './forms-native.js';
import {createNativeFrontendInput} from './frontend-input-native.js';
import {createNativeMaintenanceRuntime} from './native-maintenance.js';
import {invocationServices} from './invocation-cache.js';
export interface EffectAvailability {acceptingCommands:boolean;frontendPending:boolean;frontendLeased:boolean;formsPending:boolean;formsLeased:boolean}
export interface ScheduledHints {availability(principalId:string):EffectAvailability;reconcile:boolean}
export const SCHEDULE_PROPERTIES={reconciled:'SHAMROCK_V3_IDLE_RECONCILED_WINDOW',maintenance:'SHAMROCK_V3_MAINTENANCE_WINDOW'} as const;
function fail(message:string):never{throw new AdapterError('scheduled_probe',message);}
export function createEffectAvailabilityProbe(services:Pick<Parameters<typeof createNativeFrontendRuntime>[0],'PropertiesService'|'Utilities'|'UrlFetchApp'>,nowSeconds:()=>number){
  const cached=new Map<string,EffectAvailability>();
  return(principalId:string):EffectAvailability=>{
    const props=services.PropertiesService.getScriptProperties(),raw=props.getProperty(HOST_PROPERTIES.config);if(!raw)fail('The staging host is not configured.');
    const host=parseStagingHostConfig(JSON.parse(raw)),body=JSON.stringify({environment:'staging',generation:host.generation,principalId});
    if(cached.has(body))return cached.get(body)!;
    const signer=createGoogleSigner(services.Utilities,props.getProperty(HOST_PROPERTIES.secret)??''),timestamp=String(nowSeconds()),path='/v1/admin/effects/availability';
    const response=services.UrlFetchApp.fetch(host.workerOrigin+path,{method:'post',contentType:'application/json',payload:body,headers:{'x-shamrock-key-id':host.keyId,'x-shamrock-timestamp':timestamp,'x-shamrock-signature':signer.hmacSha256(`POST\n${path}\n${timestamp}\n${signer.sha256(body)}`)},muteHttpExceptions:true,followRedirects:false,validateHttpsCertificates:true});
    if(response.getResponseCode()!==200)fail('The current-authority work check failed; no idle result was assumed.');
    const text=response.getContentText();if(text.length>4096)fail('The work check exceeded its bounded response.');let value:EffectAvailability;
    try{value=JSON.parse(text);}catch{return fail('The work check returned an ambiguous response.');}
    if(!value||Object.keys(value).sort().join(',')!=='acceptingCommands,formsLeased,formsPending,frontendLeased,frontendPending'||Object.values(value).some(v=>typeof v!=='boolean'))fail('The work check did not match its contract.');
    cached.set(body,value);return value;
  };
}
type Services=Parameters<typeof createNativeFrontendInput>[0]&Parameters<typeof createNativeStagingHost>[0]&Parameters<typeof createNativeMaintenanceRuntime>[0]&Parameters<typeof createNativeFormsRuntime>[0];
export function runScheduledStaging(input:Services,nowSeconds=()=>Math.floor(Date.now()/1000)){
  const services=invocationServices(input),props=services.PropertiesService.getScriptProperties(),now=nowSeconds();
  const hour=String(Math.floor(now/3600)),quarter=String(Math.floor(now/900));
  const reconcile=props.getProperty(SCHEDULE_PROPERTIES.reconciled)!==hour;
  const scheduled:ScheduledHints={availability:createEffectAvailabilityProbe(services,nowSeconds),reconcile};
  const shared={...services,scheduled};
  // Controls are still discovered every tick, including when all intake gates are paused.
  const forms=createNativeFormsRuntime(shared),nativeInput=createNativeFrontendInput(shared);
  const permissions=createNativePermissionRuntime(shared);permissions.applyControl();
  const permissionResult=permissions.refresh();
  const accessFenced=props.getProperty(PERMISSION_FENCE_PROPERTY)!==null;
  forms.applyControl();if(!accessFenced)nativeInput.applyControl();
  const intake=createNativeStagingHost(shared).flush();
  const formIntake=forms.flush();
  const frontend=accessFenced?{status:'permissions-fenced'}:createNativeFrontendRuntime(shared).refresh();
  const published=forms.refresh();
  const native=accessFenced?{status:'permissions-fenced'}:nativeInput.flush({force:(frontend as {status?:string}).status==='published-with-drafts'});
  let maintenance:unknown={status:'not-due'};
  if(props.getProperty(SCHEDULE_PROPERTIES.maintenance)!==quarter){
    maintenance=createNativeMaintenanceRuntime(shared,nowSeconds).planNotifications();
    if((maintenance as {status?:string})?.status!=='busy')props.setProperty(SCHEDULE_PROPERTIES.maintenance,quarter);
  }
  // Never mark a failed/incomplete pass reconciled; the next tick retries it.
  if(reconcile)props.setProperty(SCHEDULE_PROPERTIES.reconciled,hour);
  return Object.assign({},intake,{frontend,maintenance,formIntake,forms:published,nativeInput:native,permissions:permissionResult,reconciled:reconcile});
}
