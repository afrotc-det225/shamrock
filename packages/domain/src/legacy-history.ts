/** Read-only historical projections retain source formulas and effective values; they are not new observations. */
export const LEGACY_HISTORY_VERSION = 'legacy-source-report-v1' as const;
export type LegacyPolicy = 'legacy-shamrock-credit-v1' | 'legacy-pre-v2-ur-counted' | 'legacy-pre-v2-ur-neutral' | 'unavailable';
export interface LegacyColumn { columnIndex:number;header:string;snapshotEventId:string;eventId:string|null }
export interface LegacyRange { startColumnIndex:number;endColumnIndex:number }
export interface LegacyCredit {
  policyVersion:LegacyPolicy;stored:number|string|boolean|null;calculated:number|null;matches:boolean|null;
  numerator:number|null;denominator:number|null;noCountedAttendance:boolean|null;
  sourceFormula:string|null;sourceRange:LegacyRange|null;coveredEventIds:string[];excludedEventIds:string[];
}
export interface LegacyRosterRow { personId:string|null;directoryOccurrenceId:string;profile:Record<string,unknown>;identityEvidence:string;eventEligibility:string }
export interface LegacyStoredRow {
  occurrenceId:string;personId:string|null;identityLabels:string[];
  events:(LegacyColumn&{code:string|number|boolean|null})[];overall:number|string|boolean|null;llab:number|string|boolean|null;
  creditFormulaEvidence:{overall:string|null;llab:string|null;arrayAnchorRowIndex:number};
  personEvidence:{directoryOccurrenceId:string;method:string;anchorKind:string}|null;
}
export interface LegacyHistoryInput {
  snapshotId:string;sourceSnapshotSha256:string;importedAt:string;
  metadata:{sourceTitle:string;periodLabel:string|null;isCurrent:boolean;authority:string;companionDirectoryFound:boolean;columns:LegacyColumn[]};
  sourceRoster:LegacyRosterRow[];
  rows:{row:LegacyStoredRow;sourceLabels:string[]}[];
}
export interface LegacyHistoryDiagnostic { code:'unresolved-identity'|'unknown-code'|'formula-unavailable'|'saved-percentage-mismatch'|'formula-excludes-event-columns';rowId:string;metric?:'overall'|'llab';eventId?:string }
export interface LegacyHistoryReport {
  contractVersion:typeof LEGACY_HISTORY_VERSION;snapshotId:string;sourceSnapshotSha256:string;importedAt:string;
  title:string;periodLabel:string|null;isCurrentCapture:boolean;authority:string;readOnly:true;eventEligibility:'not-reconstructed';
  eventColumns:(LegacyColumn&{machineHeader:string})[];
  sourceRoster:{personId:string|null;directoryOccurrenceId:string;lastName:string;firstName:string;asYear:string;flight:string;squadron:string;flightPathStatus:string}[];
  rows:{rowId:string;personId:string|null;identityStatus:'resolved'|'unresolved';lastName:string;firstName:string;asYear:string;flight:string;squadron:string;overall:LegacyCredit;llab:LegacyCredit;cells:{eventId:string;canonicalEventId:string|null;code:string|number|boolean|null}[]}[];
  summary:{rows:number;resolvedPeople:number;unresolvedRows:number;formulaMatches:number;formulaMismatches:number;formulaUnavailable:number;rowsWithExcludedColumns:number;storedOverallMean:number|null;storedLlabMean:number|null};
  diagnostics:LegacyHistoryDiagnostic[];
}
export class LegacyHistoryError extends Error { constructor(public readonly code:string){super(code);this.name='LegacyHistoryError';} }
function check(condition:unknown,code='INVALID_LEGACY_HISTORY'):asserts condition {if(!condition)throw new LegacyHistoryError(code);}
function id(value:unknown):asserts value is string {check(typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value));}
function text(value:unknown,max=512):asserts value is string {check(typeof value==='string'&&value.length<=max&&!value.includes('\u0000'));}
function primitive(value:unknown):asserts value is string|number|boolean|null {check(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&value.length<=512);}
const currentCredit=['P','T','E','ES','MED'],currentTotal=['P','T','A','U','E','ES','MED'];
const oldCredit=['P*','E','ES*','MU*','MRS*'],oldTotal=['P*','E','ES*','T*','U','UR','MU*','MRS*'];
const policies=[{id:'legacy-shamrock-credit-v1' as const,credit:currentCredit,total:currentTotal},{id:'legacy-pre-v2-ur-counted' as const,credit:oldCredit,total:oldTotal},{id:'legacy-pre-v2-ur-neutral' as const,credit:oldCredit,total:oldTotal.filter(x=>x!=='UR')}];
const colNumber=(label:string)=>[...label].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
function canonicalFormula(start:string,end:string,credit:string[],total:string[],llab:boolean):string {
  const summary=llab?'G':'F';return `=ARRAYFORMULA(IF(ROW(${summary}$3:${summary})<3,"",BYROW($${start}$3:$${end},LAMBDA(r,LET(`+
    (llab?`h,$${start}$1:$${end}$1,mask,BYCOL(h,LAMBDA(hd,IF(REGEXMATCH(hd,"(?i)llab"),1,0))),`:'')+
    `cred,BYCOL(r,LAMBDA(c,IF(SUM(COUNTIF(c,{"${credit.join('","')}"}))>0,1,0))),`+
    `tot,BYCOL(r,LAMBDA(c,IF(SUM(COUNTIF(c,{"${total.join('","')}"}))>0,1,0))),`+
    `num,SUM(${llab?'mask*':''}cred),den,SUM(${llab?'mask*':''}tot),IF(den=0,1,num/den))))))`;
}
interface CompiledLegacyFormula {
  sourceFormula:string|null;sourceRange:LegacyRange|null;selectedIndexes:number[];coveredEventIds:string[];excludedEventIds:string[];
  policy:typeof policies[number]|undefined;
}
/** Formula/range work depends only on the validated columns and exact saved formula, not row values. */
function compileLegacyFormula(columns:readonly LegacyColumn[],formula:string|null,metric:'overall'|'llab'):CompiledLegacyFormula {
  check(formula===null||typeof formula==='string'&&formula.length<=10000);
  const match=/BYROW\(\$([A-Z]{1,3})\$3:\$([A-Z]{1,3}),LAMBDA\(r,/.exec(formula??'');
  const range=match?{startColumnIndex:colNumber(match[1])-1,endColumnIndex:colNumber(match[2])}:null;
  const selectedIndexes:number[]=[],coveredEventIds:string[]=[],excludedEventIds:string[]=[];
  for(let index=0;index<columns.length;index++){
    const column=columns[index];
    if(!range)continue;
    if(column.columnIndex<range.startColumnIndex||column.columnIndex>=range.endColumnIndex)excludedEventIds.push(column.snapshotEventId);
    else if(metric==='overall'||/llab/i.test(column.header)){selectedIndexes.push(index);coveredEventIds.push(column.snapshotEventId);}
  }
  const policy=match&&range&&range.startColumnIndex>=7&&range.endColumnIndex>range.startColumnIndex&&range.endColumnIndex<=16384?policies.find(p=>formula===canonicalFormula(match[1],match[2],p.credit,p.total,metric==='llab')):undefined;
  return {sourceFormula:formula,sourceRange:range,selectedIndexes,coveredEventIds,excludedEventIds,policy};
}
const compiledPatterns=new Map(policies.map(policy=>[policy,{
  creditExact:new Set(policy.credit.filter(pattern=>!pattern.endsWith('*'))),creditPrefixes:policy.credit.filter(pattern=>pattern.endsWith('*')).map(pattern=>pattern.slice(0,-1)),
  totalExact:new Set(policy.total.filter(pattern=>!pattern.endsWith('*'))),totalPrefixes:policy.total.filter(pattern=>pattern.endsWith('*')).map(pattern=>pattern.slice(0,-1)),
}]));
function applyLegacyFormula(compiled:CompiledLegacyFormula,normalizedCodes:readonly string[],stored:number|string|boolean|null):LegacyCredit {
  primitive(stored);
  // Result arrays remain independent between rows even when their immutable calculation is shared.
  const common={stored,sourceFormula:compiled.sourceFormula,sourceRange:compiled.sourceRange?{...compiled.sourceRange}:null,coveredEventIds:[...compiled.coveredEventIds],excludedEventIds:[...compiled.excludedEventIds]};
  if(!compiled.policy)return {...common,policyVersion:'unavailable',calculated:null,matches:null,numerator:null,denominator:null,noCountedAttendance:null};
  const patterns=compiledPatterns.get(compiled.policy)!;let numerator=0,denominator=0;
  for(const index of compiled.selectedIndexes){const code=normalizedCodes[index];
    if(patterns.creditExact.has(code)||patterns.creditPrefixes.some(prefix=>code.startsWith(prefix)))numerator++;
    if(patterns.totalExact.has(code)||patterns.totalPrefixes.some(prefix=>code.startsWith(prefix)))denominator++;
  }
  const calculated=denominator?numerator/denominator:1;
  return {...common,policyVersion:compiled.policy.id,numerator,denominator,noCountedAttendance:denominator===0,calculated,matches:typeof stored==='number'&&Math.abs(stored-calculated)<1e-9};
}
/** Recognize the entire saved production formula, never execute arbitrary spreadsheet expressions. */
export function calculateLegacySavedCredit(columns:readonly LegacyColumn[],codes:readonly (string|number|boolean|null)[],formula:string|null,stored:number|string|boolean|null,metric:'overall'|'llab'):LegacyCredit {
  check(columns.length===codes.length&&columns.length<=128);
  return applyLegacyFormula(compileLegacyFormula(columns,formula,metric),codes.map(code=>String(code??'').toUpperCase()),stored);
}
/** A source occurrence is the row key, so an unresolved identity is retained instead of merged or dropped. */
export function buildLegacyHistoryReport(input:LegacyHistoryInput):LegacyHistoryReport {
  check(input&&typeof input==='object');id(input.snapshotId);check(/^[a-f0-9]{64}$/.test(input.sourceSnapshotSha256));check(typeof input.importedAt==='string'&&Number.isFinite(Date.parse(input.importedAt)));
  const {metadata:m}=input;check(m&&typeof m==='object');text(m.sourceTitle);if(m.periodLabel!==null)text(m.periodLabel);check(typeof m.isCurrent==='boolean');text(m.authority);
  check(Array.isArray(m.columns)&&m.columns.length<=128&&Array.isArray(input.rows)&&input.rows.length<=500&&input.rows.length*m.columns.length<=64000&&Array.isArray(input.sourceRoster)&&input.sourceRoster.length<=500,'LEGACY_HISTORY_CAPACITY');
  const columns=m.columns,seenColumns=new Set<number>(),seenEvents=new Set<string>();for(const c of columns){check(Number.isSafeInteger(c.columnIndex)&&c.columnIndex>=7&&c.columnIndex<16384&&!seenColumns.has(c.columnIndex));seenColumns.add(c.columnIndex);id(c.snapshotEventId);check(!seenEvents.has(c.snapshotEventId));seenEvents.add(c.snapshotEventId);if(c.eventId!==null)id(c.eventId);text(c.header);}
  check(columns.every((c,i)=>i===0||c.columnIndex>columns[i-1].columnIndex));
  const roster=input.sourceRoster.map(r=>{id(r.directoryOccurrenceId);if(r.personId!==null)id(r.personId);const p=r.profile;check(p&&typeof p==='object');const get=(key:string)=>{const value=p[key]??'';text(value);return value;};return {personId:r.personId,directoryOccurrenceId:r.directoryOccurrenceId,lastName:get('last_name'),firstName:get('first_name'),asYear:get('as_year'),flight:get('flight'),squadron:get('squadron'),flightPathStatus:get('flight_path_status')};});
  check(new Set(roster.map(r=>r.directoryOccurrenceId)).size===roster.length);
  const diagnostics:LegacyHistoryDiagnostic[]=[],seenRows=new Set<string>();
  // Request-local only: no actor/row/output cache survives another authorization or source read.
  const formulaCache={overall:new Map<string|null,CompiledLegacyFormula>(),llab:new Map<string|null,CompiledLegacyFormula>()};
  const formulaFor=(formula:string|null,metric:'overall'|'llab')=>{let compiled=formulaCache[metric].get(formula);if(!compiled){compiled=compileLegacyFormula(columns,formula,metric);formulaCache[metric].set(formula,compiled);}return compiled;};
  const knownCodes=new Set(['P','T','A','U','E','ES','MED','R','D','N/A','ER','ED','UR','MU','MUR','MRS']);
  const rows=input.rows.map(({row:r,sourceLabels})=>{id(r.occurrenceId);check(!seenRows.has(r.occurrenceId));seenRows.add(r.occurrenceId);if(r.personId!==null)id(r.personId);check(Array.isArray(sourceLabels)&&sourceLabels.length===5);sourceLabels.forEach(v=>text(v));check(Array.isArray(r.identityLabels)&&r.identityLabels.length===5&&sourceLabels.every((v,i)=>v.trim().toLowerCase()===r.identityLabels[i]));check(Array.isArray(r.events)&&r.events.length===columns.length);primitive(r.overall);primitive(r.llab);
    if(r.personId===null)diagnostics.push({code:'unresolved-identity',rowId:r.occurrenceId});
    const normalizedCodes:string[]=[];
    const codes=r.events.map((event,i)=>{const c=columns[i];check(event.columnIndex===c.columnIndex&&event.header===c.header&&event.snapshotEventId===c.snapshotEventId&&event.eventId===c.eventId);primitive(event.code);const normalized=String(event.code??'').toUpperCase();normalizedCodes.push(normalized);if(event.code!==null&&!knownCodes.has(normalized))diagnostics.push({code:'unknown-code',rowId:r.occurrenceId,eventId:c.snapshotEventId});return event.code;});
    check(r.creditFormulaEvidence&&typeof r.creditFormulaEvidence==='object');
    const overall=applyLegacyFormula(formulaFor(r.creditFormulaEvidence.overall,'overall'),normalizedCodes,r.overall),llab=applyLegacyFormula(formulaFor(r.creditFormulaEvidence.llab,'llab'),normalizedCodes,r.llab);
    for(const [metric,credit]of [['overall',overall],['llab',llab]] as const){if(credit.matches===null)diagnostics.push({code:'formula-unavailable',rowId:r.occurrenceId,metric});else if(!credit.matches)diagnostics.push({code:'saved-percentage-mismatch',rowId:r.occurrenceId,metric});if(credit.excludedEventIds.length)diagnostics.push({code:'formula-excludes-event-columns',rowId:r.occurrenceId,metric});}
    return {rowId:r.occurrenceId,personId:r.personId,identityStatus:r.personId===null?'unresolved' as const:'resolved' as const,lastName:sourceLabels[0],firstName:sourceLabels[1],asYear:sourceLabels[2],flight:sourceLabels[3],squadron:sourceLabels[4],overall,llab,cells:columns.map((c,i)=>({eventId:c.snapshotEventId,canonicalEventId:c.eventId,code:codes[i]}))};
  });
  return {contractVersion:LEGACY_HISTORY_VERSION,snapshotId:input.snapshotId,sourceSnapshotSha256:input.sourceSnapshotSha256,importedAt:input.importedAt,title:m.sourceTitle,periodLabel:m.periodLabel,isCurrentCapture:m.isCurrent,authority:m.authority,readOnly:true,eventEligibility:'not-reconstructed',eventColumns:columns.map(c=>({...c,machineHeader:`event:${c.snapshotEventId}`})),sourceRoster:roster,rows,
    summary:summarizeLegacyHistoryRows(rows),diagnostics};
}
/** Shared whole-report/page assembly reduction; saved source percentages remain authoritative. */
export function summarizeLegacyHistoryRows(rows:LegacyHistoryReport['rows']):LegacyHistoryReport['summary'] {
  const credits=rows.flatMap(r=>[r.overall,r.llab]),mean=(key:'overall'|'llab')=>{const values=rows.map(r=>r[key].stored).filter((n):n is number=>typeof n==='number');return values.length?values.reduce((a,b)=>a+b,0)/values.length:null;};
  return {rows:rows.length,resolvedPeople:rows.filter(r=>r.personId!==null).length,unresolvedRows:rows.filter(r=>r.personId===null).length,formulaMatches:credits.filter(c=>c.matches===true).length,formulaMismatches:credits.filter(c=>c.matches===false).length,formulaUnavailable:credits.filter(c=>c.matches===null).length,rowsWithExcludedColumns:rows.filter(r=>r.overall.excludedEventIds.length||r.llab.excludedEventIds.length).length,storedOverallMean:mean('overall'),storedLlabMean:mean('llab')};
}
/** Values-only projection for a protected historical sheet; consumers must use typed RAW writes. */
export function legacyHistoryTable(report:LegacyHistoryReport){
  const fixed=['last_name','first_name','as_year','flight','squadron','overall_attendance_pct','llab_attendance_pct'];
  return {readOnly:true as const,snapshotId:report.snapshotId,title:report.title,headers:[...fixed,...report.eventColumns.map(c=>c.machineHeader),'source_row_id','person_id','identity_status'],
    labels:['Last Name','First Name','AS Year','Flight','Squadron','Overall','LLAB',...report.eventColumns.map(c=>c.header),'Source row','Person','Identity status'],
    hiddenHeaders:['source_row_id','person_id','identity_status'],
    rows:report.rows.map(r=>[r.lastName,r.firstName,r.asYear,r.flight,r.squadron,r.overall.stored,r.llab.stored,...r.cells.map(c=>c.code),r.rowId,r.personId,r.identityStatus])};
}
