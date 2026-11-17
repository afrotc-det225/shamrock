/** Google accepts at most ten newly written Drive chips per batchUpdate. */
import { AdapterError } from './index.js';
import { verifyFrontendPublicationReadback, type FrontendPublicationPlan, type FrontendTableRead, type NativeCellData } from './frontend-publication.js';
type Kind = 'directory' | 'leadership' | 'attendance';
const kinds: Kind[] = ['directory', 'leadership', 'attendance'];
export interface FrozenPhotoCell { kind: Kind; row: number; column: number; before: NativeCellData }
interface PhotoWrite { kind: Kind; row: number; column: number; after: NativeCellData; request: Record<string, unknown> }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function fail(): never { throw new AdapterError('frontend_photos', 'The frozen photo publication differs from its reviewed cells. Keep the edit fence for recovery.'); }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const key = (p: {kind: Kind; row: number; column: number}) => `${p.kind}:${p.row}:${p.column}`;
function photoValue(cell: NativeCellData): unknown {
  if (cell.chipRuns?.length === 1 && (cell.chipRuns[0].startIndex ?? 0) === 0 && cell.chipRuns[0].chip?.richLinkProperties?.uri && !cell.chipRuns[0].chip?.personProperties) return {uri: cell.chipRuns[0].chip!.richLinkProperties!.uri};
  if (cell.chipRuns?.length || cell.userEnteredValue?.formulaValue) fail();
  const v = cell.userEnteredValue; return v?.stringValue === '' || !v || !Object.keys(v).length ? null : v;
}
export function splitFrontendPhotos(plans: Record<Kind, FrontendPublicationPlan>): { core: Record<string, unknown>[]; photos: PhotoWrite[]; needed: boolean } {
  const core: Record<string, unknown>[] = [], photos: PhotoWrite[] = [];
  let count = 0;
  for (const kind of kinds) for (const request of plans[kind].requests) {
    const body = request.updateCells as {range?: {sheetId:number;startRowIndex:number;endRowIndex:number;startColumnIndex:number;endColumnIndex:number}; rows?: {values:NativeCellData[]}[]; fields?:string} | undefined;
    const chips = body?.rows?.reduce((n,row)=>n+row.values.reduce((m,c)=>m+(c.chipRuns?.length??0),0),0)??0;
    count += chips;
    if (!chips) { core.push(request); continue; }
    const r=body!.range;
    if (!r || r.sheetId!==plans[kind].expectedAfter.sheetId || r.startRowIndex<2 || body!.fields!=='userEnteredValue,chipRuns' || !body!.rows || body!.rows.length!==r.endRowIndex-r.startRowIndex) fail();
    body!.rows.forEach((row,i)=>{
      if(row.values.length!==r.endColumnIndex-r.startColumnIndex)fail();
      row.values.forEach((cell,j)=>{
        photoValue(cell);const rowIndex=r.startRowIndex+i,column=r.startColumnIndex+j;
        photos.push({kind,row:rowIndex,column,after:copy(cell),request:{updateCells:{range:{sheetId:r.sheetId,startRowIndex:rowIndex,endRowIndex:rowIndex+1,startColumnIndex:column,endColumnIndex:column+1},rows:[{values:[copy(cell)]}],fields:'userEnteredValue,chipRuns'}}});
      });
    });
  }
  if(photos.length>500||new Set(photos.map(key)).size!==photos.length)fail();
  return {core,photos,needed:count>10};
}
export function freezeFrontendPhotos(plans: Record<Kind,FrontendPublicationPlan>, reads:Record<Kind,FrontendTableRead>): FrozenPhotoCell[] | undefined {
  const split=splitFrontendPhotos(plans);if(!split.needed)return undefined;
  return split.photos.map(p=>({kind:p.kind,row:p.row,column:p.column,before:copy(reads[p.kind].rows[p.row-2]?.[p.column]??{})}));
}
/** Validate all nonphoto data/identities before accepting an interrupted chip phase. */
export function inspectFrontendPhotoPhase(plans:Record<Kind,FrontendPublicationPlan>, frozen:FrozenPhotoCell[], reads:Record<Kind,FrontendTableRead>): {ready:boolean; batches:Record<string,unknown>[][]} {
  const split=splitFrontendPhotos(plans);
  if(!split.needed||!Array.isArray(frozen)||frozen.length!==split.photos.length||!frozen.every((p,i)=>key(p)===key(split.photos[i])&&same(Object.keys(p).sort(),['before','column','kind','row'])))fail();
  const normalized=copy(reads),remaining:Record<string,unknown>[]=[];
  for(let i=0;i<split.photos.length;i++){
    const p=split.photos[i],actual=reads[p.kind].rows[p.row-2]?.[p.column]??{};
    if(!normalized[p.kind].rows[p.row-2]||p.column>=normalized[p.kind].headers.length)return {ready:false,batches:[]};
    const after=same(photoValue(actual),photoValue(p.after));
    if(!after&&!same(photoValue(actual),photoValue(frozen[i].before)))fail();
    normalized[p.kind].rows[p.row-2][p.column]=copy(p.after);
    if(!after)remaining.push(p.request);
  }
  if(!kinds.every(k=>verifyFrontendPublicationReadback(plans[k],normalized[k])))return {ready:false,batches:[]};
  const batches:Record<string,unknown>[][]=[];for(let i=0;i<remaining.length;i+=10)batches.push(remaining.slice(i,i+10));
  return {ready:true,batches};
}
