/** Private, opt-in staging host for retained historical attendance. No production writes or mail binding. */
import { AdapterError } from './index.js';
import { createGoogleSigner, createGoogleTransport, type UtilitiesPort, type ScriptLockPort } from './apps-script.js';
import { HOST_PROPERTIES, parseStagingHostConfig } from './staging-host.js';
import { CONFIG_FILE_ID_PROPERTY } from './staging-config.js';
import { createPrivateCheckpoint } from './private-checkpoint.js';
import { continueHistoryPublication, validateHistoryState, type HistoryPublicationState, type HistoryPorts, type HistoryCatalogEntry } from './history-runtime.js';
import { historySheetPlan, historyPresentationRequests, historyPageWrites, historyPageRows, type HistoryScalar } from './history-presentation.js';
import type { HistoryPageManifest } from '../../../packages/domain/src/legacy-history-transport.js';
export const HISTORY_PROPERTIES={config:'SHAMROCK_V3_HISTORY_CONFIG',paused:'SHAMROCK_V3_HISTORY_PAUSED'} as const;
export interface NativeHistoryConfig {version:1;environment:'staging';generation:number;enabled:boolean;resourceReview:'EXISTING_PRIVATE_HISTORY_REVIEWED_FOR_STAGING';principalId:string;stateFileId:string;spreadsheetId:string;expectedTitle:string;api?:{baseUrl:string;keyId:string;secretProperty:string};}
export interface NativeHistoryServices {
  PropertiesService:{getScriptProperties():{getProperty(key:string):string|null;setProperty(key:string,value:string):unknown}};
  Session:{getEffectiveUser():{getEmail():string}};ScriptApp:{getOAuthToken():string};Utilities:UtilitiesPort;
  LockService:{getScriptLock():ScriptLockPort};UrlFetchApp:{fetch(url:string,options:{method:'get'|'post'|'patch';headers:Record<string,string>;contentType?:string;payload?:string;muteHttpExceptions:true;followRedirects:false;validateHttpsCertificates:true}):{getResponseCode():number;getContentText():string}};
}
function fail(message:string):never{throw new AdapterError('history_native',message);}
const bytes=(value:string)=>encodeURIComponent(value).replace(/%[A-F0-9]{2}/g,'x').length;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
// Google may normalize an explicitly empty string to a blank cell. Numbers, booleans and nonblank text remain exact.
const sameCells=(a:unknown,b:unknown)=>JSON.stringify(a,(_k,v)=>v===''?null:v)===JSON.stringify(b,(_k,v)=>v===''?null:v);
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(v);
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
const literal=(v:HistoryScalar)=>({userEnteredValue:v===null?{}:typeof v==='number'?{numberValue:v}:typeof v==='boolean'?{boolValue:v}:{stringValue:v}});
const quoted=(title:string)=>`'${title.replace(/'/g,"''")}'`;
const column=(index:number)=>{let n=index+1,result='';while(n){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result;};
export function parseNativeHistoryConfig(value:unknown,generation:number):NativeHistoryConfig {
  const r=value as NativeHistoryConfig,keys=['version','environment','generation','enabled','resourceReview','principalId','stateFileId','spreadsheetId','expectedTitle'];
  if(!r||typeof r!=='object'||Array.isArray(r)||keys.some(k=>!Object.hasOwn(r,k))||Object.keys(r).some(k=>!keys.includes(k)&&k!=='api')||r.version!==1||r.environment!=='staging'||r.generation!==generation||typeof r.enabled!=='boolean'||r.resourceReview!=='EXISTING_PRIVATE_HISTORY_REVIEWED_FOR_STAGING'||typeof r.principalId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(r.principalId)||!id(r.stateFileId)||!id(r.spreadsheetId)||r.stateFileId===r.spreadsheetId||typeof r.expectedTitle!=='string'||r.expectedTitle.length>200||!r.expectedTitle.trim())fail('Bind a separate reviewed private history workbook and state file.');
  if(Object.hasOwn(r,'api')&&(!r.api||!same(Object.keys(r.api).sort(),['baseUrl','keyId','secretProperty'])||!/^https:\/\/[A-Za-z0-9.-]+$/.test(r.api.baseUrl)||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(r.api.keyId)||!/^SHAMROCK_V3_HISTORY_[A-Z0-9_]{1,80}_SECRET$/.test(r.api.secretProperty)))fail('The optional history reader must use a separate named private Script Property.');
  return r;
}
export function createNativeHistoryRuntime(services:NativeHistoryServices,nowSeconds=()=>Math.floor(Date.now()/1000)) {
  const properties=services.PropertiesService.getScriptProperties();
  function google(url:string,method:'get'|'post'|'patch'='get',body?:unknown,max=512000):Record<string,any>{
    const payload=body===undefined?undefined:JSON.stringify(body);if(payload&&bytes(payload)>512000)fail('A history write exceeds its reviewed bound.');
    let response;try{response=services.UrlFetchApp.fetch(url,{method,headers:{Authorization:`Bearer ${services.ScriptApp.getOAuthToken()}`},...(payload?{contentType:'application/json',payload}:{}),muteHttpExceptions:true,followRedirects:false,validateHttpsCertificates:true});}catch{return fail('A Google history request has an unknown result. Its saved cursor must retry.');}
    const text=response.getContentText();if(response.getResponseCode()!==200||bytes(text)>max)fail(`Google history request did not complete within its bound (HTTP ${response.getResponseCode()}).`);
    try{const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{return fail('Google history returned invalid structured data.');}
  }
  const drive=(fileId:string)=>`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
  const sheets=(fileId:string)=>`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}`;
  function inspect(fileId:string,owner:string){
    const m=google(`${drive(fileId)}?fields=id,name,mimeType,size,version,driveId,trashed,owners(emailAddress)`,'get',undefined,16000);
    if(m.id!==fileId||m.driveId||m.trashed||!Array.isArray(m.owners)||m.owners.length!==1||String(m.owners[0].emailAddress).toLowerCase()!==owner||!/^[1-9][0-9]*$/.test(String(m.version)))fail('History resources must be owned by the configured automation account.');
    const p=google(`${drive(fileId)}/permissions?pageSize=100&fields=nextPageToken,permissions(type,role,emailAddress,deleted)`,'get',undefined,32000);
    if(p.nextPageToken||!Array.isArray(p.permissions)||p.permissions.length!==1||p.permissions[0].deleted||p.permissions[0].type!=='user'||p.permissions[0].role!=='owner'||String(p.permissions[0].emailAddress).toLowerCase()!==owner)fail('History resources must have exactly one owner and no other sharing.');return m;
  }
  function configuration(){
    const rawHost=properties.getProperty(HOST_PROPERTIES.config),configId=properties.getProperty(CONFIG_FILE_ID_PROPERTY);if(!rawHost||!configId)fail('Configure the isolated staging host first.');
    const host=parseStagingHostConfig(JSON.parse(rawHost));if(services.Session.getEffectiveUser().getEmail().trim().toLowerCase()!==host.expectedAutomationEmail)fail('Run history publication under the configured automation account.');
    const configMeta=inspect(configId,host.expectedAutomationEmail);if(configMeta.mimeType!=='application/json'||Number(configMeta.size)>65536)fail('The private configuration file is not a bounded JSON file.');
    const map=google(`${drive(configId)}?alt=media`,'get',undefined,65536),raw=map[HISTORY_PROPERTIES.config];if(typeof raw!=='string'||bytes(raw)>8000)fail('Add the reviewed private history configuration first.');
    const config=parseNativeHistoryConfig(JSON.parse(raw),host.generation),denied=[configId,host.journal.spreadsheetId,host.decisionInput?.spreadsheetId];
    for(const key of ['SHAMROCK_V3_FRONTEND_CONFIG','SHAMROCK_V3_MAINTENANCE_CONFIG'])if(typeof map[key]==='string'){const existing=JSON.parse(map[key]);denied.push(existing.stateFileId,existing.main?.spreadsheetId,existing.supplemental?.excusals?.spreadsheetId,existing.archiveSpreadsheetId);}
    if(denied.includes(config.stateFileId)||denied.includes(config.spreadsheetId))fail('History must use separate state and workbook bindings.');
    const secret=properties.getProperty(config.api?.secretProperty??HOST_PROPERTIES.secret)??'',signer=createGoogleSigner(services.Utilities,secret),bindingHash=signer.sha256(canonical(config));
    const api={environment:'staging' as const,generation:host.generation,baseUrl:config.api?.baseUrl??host.workerOrigin,keyId:config.api?.keyId??host.keyId};
    let privateChecked=false;
    const assertPrivate=()=>{if(privateChecked)return;const state=inspect(config.stateFileId,host.expectedAutomationEmail),book=inspect(config.spreadsheetId,host.expectedAutomationEmail);
      if(state.mimeType!=='application/json'||Number(state.size)>128000||book.mimeType!=='application/vnd.google-apps.spreadsheet'||book.name!==config.expectedTitle)fail('History metadata does not match its private bindings.');privateChecked=true;};
    assertPrivate();
    const validate=(value:unknown)=>{if(value&&typeof value==='object'&&!Array.isArray(value)&&same(Object.keys(value),['version'])&&(value as any).version===1)return {version:1,environment:'staging',generation:host.generation,bindingHash,catalog:[],completed:0,phase:'scan',offset:0,positions:[]} as HistoryPublicationState;return validateHistoryState(value,host.generation,bindingHash);};
    const checkpoint=createPrivateCheckpoint<HistoryPublicationState>({version:()=>String(inspect(config.stateFileId,host.expectedAutomationEmail).version),read:()=>google(`${drive(config.stateFileId)}?alt=media`,'get',undefined,128000),
      write(value){const saved=google(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(config.stateFileId)}?uploadType=media&fields=id,version`,'patch',value);if(saved.id!==config.stateFileId)fail('The history cursor write was not confirmed.');},validate,digest:v=>signer.sha256(canonical(v))});
    const metadata=()=>google(`${sheets(config.spreadsheetId)}?fields=spreadsheetId,sheets(properties,protectedRanges,tables)`);
    const batch=(requests:Record<string,unknown>[])=>{if(requests.length)google(`${sheets(config.spreadsheetId)}:batchUpdate`,'post',{requests});};
    const protectedSheet=(sheet:any)=>Array.isArray(sheet.protectedRanges)&&sheet.protectedRanges.some((p:any)=>p.range?.sheetId===sheet.properties.sheetId&&Object.keys(p.range).length===1&&p.warningOnly!==true&&!p.unprotectedRanges?.length&&!p.editors?.domainUsersCanEdit&&!p.editors?.groups?.length&&(p.editors?.users??[]).every((email:string)=>email.toLowerCase()===host.expectedAutomationEmail));
    function reportMetadata(manifest:HistoryPageManifest){const plan=historySheetPlan(manifest,signer.sha256),book=metadata(),sheet=book.sheets?.find((s:any)=>s.properties.sheetId===plan.sheetId);
      if(!sheet||sheet.properties.title!==plan.title||!protectedSheet(sheet)||sheet.tables?.length!==1||sheet.tables[0].name!==plan.tableName||sheet.tables[0].range?.sheetId!==plan.sheetId||sheet.tables[0].range?.startRowIndex!==1||(sheet.tables[0].range?.startColumnIndex??0)!==0||sheet.tables[0].range?.endRowIndex!==plan.rowCount||sheet.tables[0].range?.endColumnIndex!==plan.columnCount)fail('The retained report Table or whole-sheet protection differs from its binding.');return plan;}
    function readRows(title:string,start:number,count:number,cols:number):HistoryScalar[][] {
      const range=`${quoted(title)}!A${start+1}:${column(cols-1)}${start+count}`,result=google(`${sheets(config.spreadsheetId)}?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=sheets(data(startRow,startColumn,rowData(values(userEnteredValue))))`),data=result.sheets?.[0]?.data?.[0];
      if(!data||(data.startRow??0)!==start||(data.startColumn??0)!==0)fail('The historical grid read-back did not match its requested range.');
      return Array.from({length:count},(_,r)=>Array.from({length:cols},(_,c)=>{const v=data.rowData?.[r]?.values?.[c]?.userEnteredValue??{};if(Object.hasOwn(v,'formulaValue'))fail('Retained historical values must never become live formulas.');return v.stringValue??v.numberValue??v.boolValue??null;}));
    }
    function index(manifest:HistoryPageManifest,index:number,catalog:HistoryCatalogEntry[]){
      const book=metadata();let sheet=book.sheets?.find((s:any)=>s.properties.sheetId===0);const requests:Record<string,unknown>[]=[];
      if(!sheet){requests.push({addSheet:{properties:{sheetId:0,title:'History',gridProperties:{rowCount:Math.max(10,catalog.length+2),columnCount:5,frozenRowCount:2,hideGridlines:true}}}});}
      else if(!['Sheet1','History'].includes(sheet.properties.title)||sheet.tables?.length>1||sheet.tables?.length===1&&sheet.tables[0].name!=='Historical_reports')fail('The history index has an unexpected identity.');
      if(sheet?.properties.title==='Sheet1'){
        const rows=sheet.properties.gridProperties?.rowCount,cols=sheet.properties.gridProperties?.columnCount;
        if(!Number.isSafeInteger(rows)||rows<1||rows>1000||!Number.isSafeInteger(cols)||cols<5||cols>26)fail('Use the reviewed empty initial workbook for the history index.');
        const cells=readRows('Sheet1',0,rows,cols);if(cells.some(row=>row.some(value=>value!==null&&value!=='')))fail('The new history workbook must have an empty initial sheet.');
        requests.push({updateSheetProperties:{properties:{sheetId:0,title:'History'},fields:'title'}});
      }
      if(!sheet||!protectedSheet(sheet))requests.push({addProtectedRange:{protectedRange:{range:{sheetId:0},description:'Historical report index',warningOnly:false,editors:{users:[host.expectedAutomationEmail],domainUsersCanEdit:false}}}});
      requests.push({updateCells:{start:{sheetId:0,rowIndex:0,columnIndex:0},rows:[['report','source','rows','identity_review','status'],['Report','Retained source','Cadets','Identity review','Status']].map(row=>({values:row.map(literal)})),fields:'userEnteredValue'}});
      if(!sheet?.tables?.length)requests.push({addTable:{table:{name:'Historical_reports',range:{sheetId:0,startRowIndex:1,endRowIndex:Math.max(3,catalog.length+2),startColumnIndex:0,endColumnIndex:5}}}});
      requests.push({updateDimensionProperties:{range:{sheetId:0,dimension:'ROWS',startIndex:0,endIndex:1},properties:{hiddenByUser:true},fields:'hiddenByUser'}},
        {repeatCell:{range:{sheetId:0},cell:{userEnteredFormat:{textFormat:{fontFamily:'Roboto',fontSize:10},wrapStrategy:'CLIP',verticalAlignment:'MIDDLE'}},fields:'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment'}},
        {repeatCell:{range:{sheetId:0,startRowIndex:1,endRowIndex:2},cell:{userEnteredFormat:{backgroundColor:{red:0.208,green:0.408,blue:0.329},textFormat:{bold:true,foregroundColor:{red:1,green:1,blue:1}}}},fields:'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.foregroundColor'}},
        {updateDimensionProperties:{range:{sheetId:0,dimension:'ROWS',startIndex:0,endIndex:Math.max(3,catalog.length+2)},properties:{pixelSize:21},fields:'pixelSize'}});
      [220,260,70,100,170].forEach((pixelSize,columnIndex)=>requests.push({updateDimensionProperties:{range:{sheetId:0,dimension:'COLUMNS',startIndex:columnIndex,endIndex:columnIndex+1},properties:{pixelSize},fields:'pixelSize'}}));
      const plan=historySheetPlan(manifest,signer.sha256),row=[manifest.report.periodLabel||manifest.report.title,manifest.report.title,manifest.rowCount,catalog[index].unresolvedRows,'Verified retained values'].map(literal);
      row[0]={...row[0],userEnteredFormat:{textFormat:{link:{uri:`https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/edit#gid=${plan.sheetId}`}}}} as typeof row[0];
      requests.push({updateCells:{start:{sheetId:0,rowIndex:index+2,columnIndex:0},rows:[{values:row}],fields:'userEnteredValue,userEnteredFormat.textFormat.link'}},{updateSheetProperties:{properties:{sheetId:plan.sheetId,hidden:false},fields:'hidden'}});batch(requests);
    }
    const ports:HistoryPorts={config:api,principalId:config.principalId,signer,transport:createGoogleTransport(services.UrlFetchApp),nowSeconds,lock:services.LockService.getScriptLock(),bindingHash,enabled:()=>config.enabled&&properties.getProperty(HISTORY_PROPERTIES.paused)==='false',assertPrivate,state:checkpoint,
      report:{ensure(manifest){const plan=historySheetPlan(manifest,signer.sha256),book=metadata(),existing=book.sheets?.find((s:any)=>s.properties.sheetId===plan.sheetId);if(existing){reportMetadata(manifest);return;}if(book.sheets?.some((s:any)=>s.properties.title===plan.title))fail('A historical report title collides with a different sheet.');batch(historyPresentationRequests(manifest,plan,host.expectedAutomationEmail));},
        write(manifest,page,positions){batch(historyPageWrites(manifest,historySheetPlan(manifest,signer.sha256),page,positions));},
        version:()=>String(inspect(config.spreadsheetId,host.expectedAutomationEmail).version),
        verifyHeaders(manifest){const plan=reportMetadata(manifest);if(!sameCells(readRows(plan.title,0,2,plan.columnCount),[plan.headers,plan.labels]))fail('Historical report headers do not match the retained source.');},
        verify(manifest,page,positions){const plan=historySheetPlan(manifest,signer.sha256),expected=historyPageRows(manifest,page);page.rows.forEach((entry,i)=>{const at=positions.findIndex(p=>p.rowId===entry.row.rowId&&p.sourceRowIndex===entry.sourceRowIndex);if(at<0||!sameCells(readRows(plan.title,at+2,1,plan.columnCount)[0],expected[i]))fail('Historical literal read-back differs from its retained source row.');});},
        publish:index}};
    return {config,bindingHash,ports};
  }
  function pause(){properties.setProperty(HISTORY_PROPERTIES.paused,'true');if(properties.getProperty(HISTORY_PROPERTIES.paused)!=='true')fail('History pause was not saved.');return {state:'paused'};}
  function setup(){pause();const c=configuration();c.ports.state.load();return {state:'paused',bindingHash:c.bindingHash};}
  function resume(reviewedBindingHash:string){const c=configuration();if(!c.config.enabled||reviewedBindingHash!==c.bindingHash)fail('Review the exact private history binding before enabling its scheduler.');c.ports.state.load();properties.setProperty(HISTORY_PROPERTIES.paused,'false');if(properties.getProperty(HISTORY_PROPERTIES.paused)!=='false')fail('History enablement was not saved.');return {state:'enabled',bindingHash:c.bindingHash};}
  function run(){if(properties.getProperty(HISTORY_PROPERTIES.paused)!=='false')return {state:'paused'};const c=configuration();return continueHistoryPublication(c.ports);}
  return {setup,pause,resume,run};
}
