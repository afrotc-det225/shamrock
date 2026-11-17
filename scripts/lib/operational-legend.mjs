/** Canonical legend maintenance produces reviewable source/config patches, never ad hoc sheet edits. */
import ts from 'typescript';
import {createHash} from 'node:crypto';
import {readOperationalCsv,writeOperationalCsv} from './operational-csv.mjs';
export const LEGEND_SOURCES={as_year_options:'AS_YEARS',flight_options:'FLIGHTS',squadron_options:'SQUADRONS',cadet_rank_options:'CADET_RANKS',rank_options:'RANKS',honorific_options:'HONORIFICS',university_options:'UNIVERSITIES',dorm_options:'DORMS',cip_broad_area_options:'CIP_BROAD_AREAS',afsc_options:'AFSC_OPTIONS',home_state_options:'HOME_STATES',flight_path_status_options:'FLIGHT_PATH_STATUSES',attendance_code_options:'ATTENDANCE_CODES',excusal_decision_options:'EXCUSAL_DECISIONS',excusal_status_options:'EXCUSAL_STATUSES',excusal_requested_outcome_options:'EXCUSAL_REQUESTED_OUTCOMES'};
const FIXED=new Set(['as_year_options','flight_options','squadron_options','flight_path_status_options','attendance_code_options','excusal_decision_options','excusal_status_options','excusal_requested_outcome_options']);
const FORM_FIELDS={as_year_options:'asYear',cadet_rank_options:'rank',university_options:'university',dorm_options:'dorm',cip_broad_area_options:'cipBroadArea',afsc_options:'afsc',home_state_options:'homeState',flight_path_status_options:'flightPathStatus'};
const hash=text=>createHash('sha256').update(text).digest('hex'),check=(v,code)=>{if(!v)throw Error(code);};
export function readCanonicalLegend(source){
 const ast=ts.createSourceFile('arrays.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),arrays=new Map();
 const visit=node=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&Object.values(LEGEND_SOURCES).includes(node.name.text)){
  check(node.initializer&&ts.isArrayLiteralExpression(node.initializer)&&node.initializer.elements.every(ts.isStringLiteralLike),'ADMIN_LEGEND_SOURCE');
  check(!arrays.has(node.name.text),'ADMIN_LEGEND_DUPLICATE_SOURCE');arrays.set(node.name.text,{values:node.initializer.elements.map(v=>v.text),start:node.initializer.getStart(ast),end:node.initializer.end});
 }ts.forEachChild(node,visit);};visit(ast);
 check(arrays.size===Object.keys(LEGEND_SOURCES).length,'ADMIN_LEGEND_SOURCE');return {values:Object.fromEntries(Object.entries(LEGEND_SOURCES).map(([list,name])=>[list,arrays.get(name).values])),arrays};
}
export function exportCanonicalLegend(source){const {values}=readCanonicalLegend(source);return writeOperationalCsv('data_legend',Object.entries(values).flatMap(([list,options])=>options.map((value,position)=>({list,position,value}))));}
export function planCanonicalLegend(csv,source,{reason,formsConfig}={}){
 check(typeof reason==='string'&&reason.trim()&&reason.length<=4000,'ADMIN_LEGEND_REVIEW');const prior=readCanonicalLegend(source),rows=readOperationalCsv(csv,'data_legend'),next={};
 for(const row of rows){check(Object.hasOwn(LEGEND_SOURCES,row.list)&&/^(0|[1-9][0-9]*)$/.test(row.position)&&row.value.length>0&&row.value.length<=512&&row.value===row.value.trim()&&!/[\u0000-\u001f\u007f]/.test(row.value),'ADMIN_LEGEND_ROW');const values=next[row.list]??=[];check(Number(row.position)===values.length&&!values.includes(row.value),'ADMIN_LEGEND_ORDER');values.push(row.value);}
 check(Object.keys(next).length===Object.keys(LEGEND_SOURCES).length,'ADMIN_LEGEND_MISSING_LIST');const changes=[];
 for(const [list,values]of Object.entries(next)){const before=prior.values[list];check(before.every(v=>values.includes(v)),'ADMIN_LEGEND_EXISTING_CHOICES_REQUIRED');if(JSON.stringify(before)===JSON.stringify(values))continue;check(!FIXED.has(list),'ADMIN_LEGEND_POLICY_CHANGE_REQUIRED');changes.push({list,sourceExport:LEGEND_SOURCES[list],before,after:values});}
 let proposedSource=source;for(const change of [...changes].sort((a,b)=>prior.arrays.get(b.sourceExport).start-prior.arrays.get(a.sourceExport).start)){const range=prior.arrays.get(change.sourceExport);proposedSource=proposedSource.slice(0,range.start)+JSON.stringify(change.after)+proposedSource.slice(range.end);}
 const privateConfigChanges=[],proposedFormsConfig=formsConfig?structuredClone(formsConfig):undefined;
 if(proposedFormsConfig){check(Array.isArray(proposedFormsConfig.forms),'ADMIN_LEGEND_FORMS_CONFIG');for(const [formIndex,form]of proposedFormsConfig.forms.entries())for(const [choiceIndex,choice]of (form.choices??[]).entries()){
  if(choice.source?.kind!=='directory')continue;const change=changes.find(c=>FORM_FIELDS[c.list]===choice.source.field);if(!change)continue;
  check(JSON.stringify(choice.source.values)===JSON.stringify(change.before),'ADMIN_LEGEND_CONFIG_DRIFT');privateConfigChanges.push({pointer:`/forms/${formIndex}/choices/${choiceIndex}/source/values`,before:change.before,after:change.after});choice.source.values=change.after;
 }}
 const plan={formatVersion:1,kind:'canonical-legend-change',reason,sourcePath:'src/utils/arrays.ts',sourceSha256:hash(source),proposedSourceSha256:hash(proposedSource),changes,privateConfigChanges,...(formsConfig?{privateConfigSha256:hash(JSON.stringify(formsConfig)),proposedPrivateConfigSha256:hash(JSON.stringify(proposedFormsConfig))}:{}),requirements:{sourceReview:true,buildAndTests:true,reviewedNativeLegendPublication:true,preserveNativeDropdownStyle:true,productionDeployment:false}};
 return {plan:{...plan,planHash:hash(JSON.stringify(plan))},proposedSource,proposedFormsConfig,legendValues:next};
}
