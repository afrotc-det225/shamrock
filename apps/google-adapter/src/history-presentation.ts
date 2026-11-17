/** Immutable source reports use the same compact Attendance layout as the operational workbook. */
import { buildAttendanceLayout } from './frontend-layout.js';
import { legacyHistoryTable, type LegacyHistoryReport } from '../../../packages/domain/src/legacy-history.js';
import type { HistoryPageManifest, HistoryRowsPage } from '../../../packages/domain/src/legacy-history-transport.js';
export type HistoryScalar = string | number | boolean | null;
export interface HistorySheetPlan { sheetId:number; title:string; tableName:string; headers:string[]; labels:string[]; rowCount:number; columnCount:number; hiddenStart:number; }
const color=(hex:string)=>({red:parseInt(hex.slice(1,3),16)/255,green:parseInt(hex.slice(3,5),16)/255,blue:parseInt(hex.slice(5,7),16)/255});
const literal=(value:HistoryScalar)=>({userEnteredValue:value===null?{}:typeof value==='number'?{numberValue:value}:typeof value==='boolean'?{boolValue:value}:{stringValue:value}});
const report=(manifest:HistoryPageManifest,rows:LegacyHistoryReport['rows']=[]):LegacyHistoryReport=>({...manifest.report,rows,sourceRoster:[],diagnostics:[],summary:{rows:rows.length,resolvedPeople:0,unresolvedRows:0,formulaMatches:0,formulaMismatches:0,formulaUnavailable:0,rowsWithExcludedColumns:0,storedOverallMean:null,storedLlabMean:null}});
export function historySheetPlan(manifest:HistoryPageManifest,sha:(value:string)=>string):HistorySheetPlan {
  const token=sha(manifest.snapshotId);if(!/^[a-f0-9]{64}$/.test(token))throw Error('INVALID_HISTORY_DIGEST');
  const table=legacyHistoryTable(report(manifest)),seen=new Set<string>();
  // Native Tables require distinct display names. The exact source header remains a cell note.
  const labels=table.labels.map(label=>{let candidate=label||'Unnamed event',suffix=1;while(seen.has(candidate.toLowerCase()))candidate=`${label||'Unnamed event'} (${++suffix})`;seen.add(candidate.toLowerCase());return candidate;});
  return {sheetId:1+parseInt(token.slice(0,7),16),title:`${(manifest.report.periodLabel||manifest.report.title).replace(/[\\/?*\[\]:]/g,' ').slice(0,70)} · ${token.slice(0,6)}`,tableName:`History_${token.slice(0,16)}`,headers:table.headers,labels,rowCount:Math.max(3,manifest.rowCount+2),columnCount:table.headers.length,hiddenStart:table.headers.length-3};
}
export function historyPresentationRequests(manifest:HistoryPageManifest,plan:HistorySheetPlan,owner:string):Record<string,unknown>[] {
  const range={sheetId:plan.sheetId,startRowIndex:1,endRowIndex:plan.rowCount,startColumnIndex:0,endColumnIndex:plan.columnCount};
  const requests:Record<string,unknown>[]=[
    {addSheet:{properties:{sheetId:plan.sheetId,title:plan.title,hidden:true,gridProperties:{rowCount:plan.rowCount,columnCount:plan.columnCount}}}},
    {addProtectedRange:{protectedRange:{range:{sheetId:plan.sheetId},description:`Retained source report ${manifest.snapshotId}`,warningOnly:false,editors:{users:[owner],domainUsersCanEdit:false}}}},
    {updateCells:{start:{sheetId:plan.sheetId,rowIndex:0,columnIndex:0},rows:[plan.headers,plan.labels].map(row=>({values:row.map(literal)})),fields:'userEnteredValue'}},
    {addTable:{table:{name:plan.tableName,range,rowsProperties:{headerColorStyle:{rgbColor:color('#356854')},firstBandColorStyle:{rgbColor:color('#FFFFFF')},secondBandColorStyle:{rgbColor:color('#F6F8F9')}},columnProperties:plan.labels.map((columnName,columnIndex)=>({columnIndex,columnName,columnType:'COLUMN_TYPE_UNSPECIFIED'}))}}},
    ...buildAttendanceLayout({sheetId:plan.sheetId,headers:plan.headers,labels:plan.labels,eventHeaders:manifest.report.eventColumns.map(c=>c.machineHeader),dataEndRow:plan.rowCount}),
    {repeatCell:{range:{...range,endRowIndex:2},cell:{userEnteredFormat:{backgroundColor:color('#356854'),textFormat:{foregroundColor:color('#FFFFFF')}}},fields:'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.foregroundColor'}},
    {updateDimensionProperties:{range:{sheetId:plan.sheetId,dimension:'COLUMNS',startIndex:plan.hiddenStart,endIndex:plan.columnCount},properties:{hiddenByUser:true},fields:'hiddenByUser'}},
    {updateCells:{start:{sheetId:plan.sheetId,rowIndex:1,columnIndex:0},rows:[{values:[{note:`Retained source report: ${manifest.report.title}. Saved attendance codes and percentages are shown literally. Historical eligibility and editor identity are not reconstructed.`}]}],fields:'note'}},
  ];
  manifest.report.eventColumns.forEach((column,i)=>requests.push({updateCells:{start:{sheetId:plan.sheetId,rowIndex:1,columnIndex:i+7},rows:[{values:[{note:`Source event label: ${column.header}`}]}],fields:'note'}}));
  const codes:Record<string,[string,string]>={P:['#D9EAD3','#274E13'],T:['#FFF2CC','#7F6000'],A:['#F4CCCC','#990000'],U:['#F4CCCC','#990000'],D:['#F4CCCC','#990000'],E:['#D9EAD3','#274E13'],ES:['#D9EAD3','#274E13'],MED:['#D9D2E9','#674EA7'],R:['#FFF2CC','#7F6000']};
  if(manifest.report.eventColumns.length)Object.entries(codes).forEach(([code,[background,ink]],index)=>requests.push({addConditionalFormatRule:{index,rule:{ranges:[{sheetId:plan.sheetId,startRowIndex:2,endRowIndex:plan.rowCount,startColumnIndex:7,endColumnIndex:plan.hiddenStart}],booleanRule:{condition:{type:'TEXT_EQ',values:[{userEnteredValue:code}]},format:{backgroundColor:color(background),textFormat:{foregroundColor:color(ink)}}}}}}));
  return requests;
}
export function historyPageRows(manifest:HistoryPageManifest,page:HistoryRowsPage):HistoryScalar[][] {return legacyHistoryTable(report(manifest,page.rows.map(r=>r.row))).rows;}
/** Source row position is mapped separately from mutable display order and never inferred from a name. */
export function historyPageWrites(manifest:HistoryPageManifest,plan:HistorySheetPlan,page:HistoryRowsPage,positions:readonly {rowId:string;sourceRowIndex:number}[]):Record<string,unknown>[] {
  const rows=historyPageRows(manifest,page);
  return page.rows.map((entry,i)=>{const position=positions.findIndex(p=>p.rowId===entry.row.rowId&&p.sourceRowIndex===entry.sourceRowIndex);if(position<0)throw Error('INVALID_HISTORY_ROW_BINDING');
    const values:Record<string,unknown>[]=rows[i].map(literal),notes:string[]=[];
    if(entry.row.identityStatus==='unresolved')notes.push('Historical identity needs review. This source row is retained separately and has not been assigned to a current cadet.');
    if(entry.diagnostics.some(d=>d.code==='unknown-code'))notes.push('This row contains a retained attendance code that is not recognized by the current code legend.');
    if(notes.length)values[0]={...values[0],note:notes.join('\n'),userEnteredFormat:{backgroundColor:color('#FFF2CC')}};
    for(const [key,index] of [['overall',5],['llab',6]] as const){const credit=entry.row[key];values[index]={...values[index],note:`Saved source percentage; ${credit.policyVersion==='unavailable'?'the original calculation could not be verified':credit.matches?'verified against the retained source formula':'differs from the recognized retained source formula'}.${credit.excludedEventIds.length?' The source formula excluded some retained event columns.':''}`};}
    return {updateCells:{start:{sheetId:plan.sheetId,rowIndex:position+2,columnIndex:0},rows:[{values}],fields:'userEnteredValue,note,userEnteredFormat.backgroundColor'}};
  });
}
