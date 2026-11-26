// Keep only aggregate counts in this tab. A missing provider measurement stays unknown.
const totals=()=>({requests:0,receipts:0,rows:0,unknown:0});
const lifetime=totals(), buckets=new Map(), groups=new Map();
export function beginApiRead(path,profile) {
  const group=path==='/state'?profile:({'/receipts':'Change receipts','/session':'Session','/system/diagnostics':'Catalog checks','/wing-charts':'Wing charts','/page':'Record pages'}[path]??'Other requests');
  const countsForGroup=groups.get(group)??totals();groups.set(group,countsForGroup);
  const sec=Math.floor(performance.now()/1000);
  for(const s of buckets.keys()) if(s<=sec-60) buckets.delete(s);
  const bucket=buckets.get(sec)??totals(); buckets.set(sec,bucket);
  for(const counts of [bucket,lifetime,countsForGroup]) {
    counts.requests++;counts.unknown++;
    if(path==='/receipts') counts.receipts++;
  }
  return response=>{
    const rows=response.headers.get('X-Shamrock-D1-Rows-Read');
    if(response.ok && /^\d+$/.test(rows??'')) {
      for(const counts of [bucket,lifetime,countsForGroup]) {counts.unknown--;counts.rows+=Number(rows);}
    }
  };
}
export function readUsage(){
  const minute=totals(), now=Math.floor(performance.now()/1000);
  for(const [s,b] of buckets) if(now-s<60) for(const k of Object.keys(minute)) minute[k]+=b[k];
  return {minute,tab:{...lifetime},groups:[...groups.entries()].map(([name,c])=>[name,{...c}])};
}
