/** Owner-private immutable records with bounded, automatically split lookup indexes.
 * Caller holds the same ScriptLock as the active journals. No deletion is performed. */
import {AdapterError} from './index.js';
export const retentionCanonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const bytes=(v:string)=>encodeURIComponent(v).replace(/%[A-F0-9]{2}/g,'x').length;
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function fail(message:string):never{throw new AdapterError('private_retention',message);}
type Pointer={key:string;hash:string;bytes:number;inline?:unknown;fileId?:string;pending?:string};
type Bucket={version:1;prefix:string;records:Record<string,Pointer>};
export interface RetentionIndex {version:1;environment:'staging';generation:number;buckets:Record<string,string>;retired?:{prefix:string;fileId:string;sha256:string}[];
  split?:{prefix:string;fileId:string;sha256:string;children:Record<string,string>};}
export interface RetentionStore {get(key:string):unknown|undefined;put(records:{key:string;value:unknown}[]):void;}
/** Reviewed volume rollover retains old lookup roots; only the current volume receives new records. */
export function combineRetentionVolumes(current:RetentionStore,previous:RetentionStore[]):RetentionStore{
  if(previous.length>4)fail('Review archive consolidation before adding another retained volume.');
  function get(key:string){let found:unknown;for(const volume of[current,...previous]){const value=volume.get(key);if(value===undefined)continue;if(found!==undefined&&retentionCanonical(found)!==retentionCanonical(value))fail('Historical archive volumes disagree on an immutable record.');found=value;}return found;}
  return{get,put(records){const fresh=[];for(const r of records){const old=get(r.key);if(old===undefined)fresh.push(r);else if(retentionCanonical(old)!==retentionCanonical(r.value))fail('An immutable record cannot be rebound across archive volumes.');}if(fresh.length)current.put(fresh);}};
}
export interface RetentionPorts {
  generation:number;sha256(text:string):string;
  root:{load():RetentionIndex;save(value:RetentionIndex):void};
  reserveIds(count:number):string[];
  /** null means the pre-reserved file does not yet exist. All native reads verify exact owner/ACL/parent. */
  read(fileId:string):string|null;
  /** Uses an already-reserved ID. Existing content must match exactly; no replacement permitted. */
  create(fileId:string,text:string,label:string):void;
  /** Compare exact prior content and verify the new content; metadata-only version drift is harmless. */
  replaceIndex(fileId:string,before:string,after:string):void;
}
export function createPrivateRetention(io:RetentionPorts,limits={bucketBytes:750_000,bucketRecords:4096}):RetentionStore{
  if(limits.bucketBytes<2048||limits.bucketBytes>2_000_000||limits.bucketRecords<2||limits.bucketRecords>10000)fail('Invalid retention index bounds.');
  let root:RetentionIndex|undefined;const buckets=new Map<string,{value:Bucket;text:string}>();
  const digest=(value:string)=>{const hash=io.sha256(value);if(!/^[a-f0-9]{64}$/.test(hash))fail('Retention hashing failed.');return hash;};
  function index(){if(!root){root=io.root.load();if(root.version!==1||root.environment!=='staging'||root.generation!==io.generation||!root.buckets||Array.isArray(root.buckets))fail('The private archive belongs to another generation.');
      if(Object.keys(root.buckets).some(p=>! /^[a-f0-9]{1,4}$/.test(p))||new Set(Object.values(root.buckets)).size!==Object.keys(root.buckets).length)fail('The retention directory is invalid.');}return root;}
  function saveRoot(){const value=index();if(bytes(retentionCanonical(value))>2_000_000)fail('The archive directory needs a reviewed new volume; nothing was deleted.');io.root.save(copy(value));}
  function readBucket(prefix:string,fileId:string,allowMissing=false){const cached=buckets.get(prefix);if(cached)return cached;
    let text=io.read(fileId);if(text===null){if(!allowMissing)fail('A retained index file is unavailable; retry the saved archive operation.');const value:Bucket={version:1,prefix,records:{}};text=retentionCanonical(value);io.create(fileId,text,'SHAMROCK retention index');}
    let value:Bucket;try{value=JSON.parse(text);}catch{return fail('A retained index is invalid.');}
    if(value.version!==1||value.prefix!==prefix||!value.records||Array.isArray(value.records)||Object.entries(value.records).some(([h,p])=>!h.startsWith(prefix)||digest(p.key)!==h||! /^[a-f0-9]{64}$/.test(p.hash)))fail('A retained lookup binding changed.');
    const result={value,text};buckets.set(prefix,result);return result;
  }
  function completeSplit(){const s=index().split;if(!s)return;const old=readBucket(s.prefix,s.fileId);if(digest(old.text)!==s.sha256)fail('The pending archive rotation source changed.');
    for(const[prefix,fileId]of Object.entries(s.children)){const value:Bucket={version:1,prefix,records:Object.fromEntries(Object.entries(old.value.records).filter(([h])=>h.startsWith(prefix)))};const text=retentionCanonical(value);io.create(fileId,text,'SHAMROCK retention index');if(io.read(fileId)!==text)fail('Archive rotation readback failed.');}
    delete index().buckets[s.prefix];Object.assign(index().buckets,s.children);index().retired??=[];index().retired!.push({prefix:s.prefix,fileId:s.fileId,sha256:s.sha256});delete index().split;saveRoot();buckets.delete(s.prefix);
  }
  function prefixFor(hash:string,create=false):string|undefined{const found=Object.keys(index().buckets).filter(p=>hash.startsWith(p)).sort((a,b)=>b.length-a.length)[0];if(found)return found;if(!create)return;
    const prefix=hash[0],ids=io.reserveIds(1);if(ids.length!==1||!ids[0])fail('A private archive ID could not be reserved.');index().buckets[prefix]=ids[0];saveRoot();return prefix;
  }
  function materialize(p:Pointer){if(p.inline!==undefined){const text=retentionCanonical(p.inline);if(digest(text)!==p.hash||bytes(text)!==p.bytes)fail('An archived value changed.');return copy(p.inline);}
    if(!p.fileId)fail('An archived object binding is incomplete.');let text=io.read(p.fileId);
    if(text===null&&p.pending!==undefined){if(digest(p.pending)!==p.hash||bytes(p.pending)!==p.bytes)fail('The reserved archive payload changed.');io.create(p.fileId,p.pending,'SHAMROCK retained evidence');text=io.read(p.fileId);}
    if(text===null||digest(text)!==p.hash||bytes(text)!==p.bytes)fail('An archived object is missing or changed; retain the live journal.');try{return JSON.parse(text);}catch{return fail('An archived object is invalid JSON.');}}
  function find(key:string){const hash=digest(key),prefix=prefixFor(hash);if(!prefix)return;const p=readBucket(prefix,index().buckets[prefix],true).value.records[hash];if(p&&p.key!==key)fail('An archive key collided.');return p;}
  return{get(key){completeSplit();const p=find(key);return p?materialize(p):undefined;},put(records){
    if(records.length>2000||new Set(records.map(r=>r.key)).size!==records.length)fail('Archive one bounded, distinct record batch.');completeSplit();
    const prepared=records.map(r=>{if(!r.key||r.key.length>512||r.value===undefined)fail('Invalid private archive record.');const text=retentionCanonical(r.value);if(bytes(text)>256_000)fail('Split oversized evidence into immutable bounded blocks before archival.');return{...r,text,hash:digest(text),keyHash:digest(r.key)};});
    if(prepared.reduce((n,r)=>n+bytes(r.text),0)>3_000_000)fail('The archive batch exceeds its bounded write budget.');
    const missing=[...new Set(prepared.filter(r=>prefixFor(r.keyHash)===undefined).map(r=>r.keyHash[0]))];
    if(missing.length){const ids=io.reserveIds(missing.length);if(ids.length!==missing.length||new Set(ids).size!==ids.length||ids.some(id=>!id))fail('Private archive index IDs could not be reserved.');missing.forEach((p,i)=>{index().buckets[p]=ids[i];});saveRoot();}
    // Group writes by index so one Form edition does not cause one Drive write per token.
    let groups:Map<string,typeof prepared>;
    for(;;){groups=new Map();for(const r of prepared){const prefix=prefixFor(r.keyHash,true)!;const group=groups.get(prefix)??[];group.push(r);groups.set(prefix,group);}
      let split=false;for(const[prefix,group]of groups){const b=readBucket(prefix,index().buckets[prefix],true),fresh=group.filter(r=>!b.value.records[r.keyHash]);
        const growth=fresh.reduce((n,r)=>n+r.key.length+220+(bytes(r.text)<=768?bytes(r.text):0),0);
        if(Object.keys(b.value.records).length+fresh.length<=limits.bucketRecords&&bytes(b.text)+growth<=limits.bucketBytes)continue;
        if(prefix.length>=4)fail('This archive volume needs reviewed expansion; existing evidence remains available.');
        const ids=io.reserveIds(16);if(ids.length!==16||new Set(ids).size!==16)fail('Archive rotation IDs could not be reserved.');
        index().split={prefix,fileId:index().buckets[prefix],sha256:digest(b.text),children:Object.fromEntries([... '0123456789abcdef'].map((c,i)=>[prefix+c,ids[i]]))};saveRoot();completeSplit();split=true;break;
      }if(!split)break;
    }
    for(const[prefix,group]of groups!){const b=readBucket(prefix,index().buckets[prefix],true),before=b.text;
      const freshBlobs=group.filter(r=>!b.value.records[r.keyHash]&&bytes(r.text)>768),ids:string[]=[];
      for(let n=0;n<freshBlobs.length;n+=1000){const count=Math.min(1000,freshBlobs.length-n),reserved=io.reserveIds(count);if(reserved.length!==count)fail('Archive object IDs could not be reserved.');ids.push(...reserved);}
      if(new Set(ids).size!==ids.length||ids.some(id=>!id))fail('Archive object IDs collided.');let nextId=0;
      for(const r of group){const old=b.value.records[r.keyHash];if(old){if(old.key!==r.key||old.hash!==r.hash||old.bytes!==bytes(r.text))fail('An immutable archive record cannot be rebound.');continue;}
        const p:Pointer={key:r.key,hash:r.hash,bytes:bytes(r.text)};if(bytes(r.text)<=768)p.inline=copy(r.value);else{p.fileId=ids[nextId++];p.pending=r.text;}b.value.records[r.keyHash]=p;
      }
      const after=retentionCanonical(b.value);if(bytes(after)>2_000_000)fail('The pending immutable archive payload needs a smaller batch.');if(after!==before){io.replaceIndex(index().buckets[prefix],before,after);b.text=after;}
      // Exact object IDs were saved above. Missing objects from interrupted creates use those same IDs.
      for(const r of group){const p=b.value.records[r.keyHash];if(p.fileId&&io.read(p.fileId)===null)io.create(p.fileId,r.text,'SHAMROCK retained evidence');
        if(retentionCanonical(materialize(p))!==r.text)fail('Retained evidence verification failed.');delete p.pending;}
      const settled=retentionCanonical(b.value);if(settled!==b.text){io.replaceIndex(index().buckets[prefix],b.text,settled);b.text=settled;}
    }
  }};
}
