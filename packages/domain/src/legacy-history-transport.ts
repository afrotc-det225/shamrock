import { summarizeLegacyHistoryRows, type LegacyHistoryReport } from './legacy-history.js';
export const HISTORY_PAGE_VERSION='legacy-history-pages-v1' as const;
export interface HistoryPageBinding {contractVersion:typeof HISTORY_PAGE_VERSION;snapshotId:string;sourceSnapshotSha256:string;importedAt:string;}
export interface HistoryPageManifest extends HistoryPageBinding {section:'manifest';report:Omit<LegacyHistoryReport,'rows'|'sourceRoster'|'summary'|'diagnostics'>;rowCount:number;rosterCount:number;}
export interface HistoryRowsPage extends HistoryPageBinding {section:'rows';offset:number;nextOffset:number|null;rows:{sourceRowIndex:number;row:LegacyHistoryReport['rows'][number];diagnostics:LegacyHistoryReport['diagnostics']}[];}
export interface HistoryRosterPage extends HistoryPageBinding {section:'roster';offset:number;nextOffset:number|null;rows:LegacyHistoryReport['sourceRoster'];}
export interface HistoryVerifyPage extends HistoryPageBinding {section:'verify';verified:true;}
export type HistoryPage=HistoryPageManifest|HistoryRowsPage|HistoryRosterPage|HistoryVerifyPage;
/** Only complete immutable imported archives can be assembled, preserving source row order and exact saved formulas. */
export function assembleLegacyHistoryPages(manifest:HistoryPageManifest,pages:(HistoryRowsPage|HistoryRosterPage)[],verified:HistoryVerifyPage):LegacyHistoryReport {
  const check=(condition:unknown)=>{if(!condition)throw new Error('INVALID_HISTORY_PAGE_SEQUENCE');};
  const bound=(p:HistoryPage)=>p?.contractVersion===HISTORY_PAGE_VERSION&&p.snapshotId===manifest.snapshotId&&p.sourceSnapshotSha256===manifest.sourceSnapshotSha256&&p.importedAt===manifest.importedAt;
  check(manifest?.contractVersion===HISTORY_PAGE_VERSION&&manifest.section==='manifest'&&bound(verified)&&verified.section==='verify'&&verified.verified===true);
  check(Number.isSafeInteger(manifest.rowCount)&&manifest.rowCount>=0&&manifest.rowCount<=500&&Number.isSafeInteger(manifest.rosterCount)&&manifest.rosterCount>=0&&manifest.rosterCount<=500);
  const raw:HistoryRowsPage['rows']=[],roster:LegacyHistoryReport['sourceRoster']=[];let i=0;
  for(const section of ['roster','rows'] as const){const count=section==='rows'?manifest.rowCount:manifest.rosterCount;let offset=0;do{const page=pages[i++];check(bound(page)&&page.section===section&&page.offset===offset&&Array.isArray(page.rows)&&page.rows.length<=64&&offset+page.rows.length<=count);offset+=page.rows.length;check(page.rows.length>0||count===0);check(page.nextOffset===(offset<count?offset:null));if(page.section==='rows')raw.push(...page.rows);else roster.push(...page.rows);}while(offset<count);}
  check(i===pages.length&&new Set(raw.map(r=>r.row.rowId)).size===raw.length&&new Set(raw.map(r=>r.sourceRowIndex)).size===raw.length&&new Set(roster.map(r=>r.directoryOccurrenceId)).size===roster.length);
  check(raw.every(r=>Number.isSafeInteger(r.sourceRowIndex)&&r.sourceRowIndex>=2));raw.sort((a,b)=>a.sourceRowIndex-b.sourceRowIndex||(a.row.rowId<b.row.rowId?-1:1));
  const rows=raw.map(r=>r.row);return {...manifest.report,rows,sourceRoster:roster,summary:summarizeLegacyHistoryRows(rows),diagnostics:raw.flatMap(r=>r.diagnostics)};
}
