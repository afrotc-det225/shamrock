// Meter D1 work at the provider boundary, including bookmarks. A method that
// does not return provider metadata makes the total unknown for this request.
export function meterPanelReads(database:D1Database) {
  let rows:number|null=0;
  const originals=new WeakMap<D1PreparedStatement,D1PreparedStatement>();
  function record(result:D1Result) {
    const count=result.meta?.rows_read;
    rows=rows!==null && Number.isSafeInteger(count) && count>=0 ? rows+count : null;
  }
  function statement(original:D1PreparedStatement):D1PreparedStatement {
    const wrapped=new Proxy(original,{
      get(target,key){
        if(key==='bind')return (...args:unknown[])=>statement(target.bind(...args));
        if(key==='run' || key==='all')return async (...args:[])=>{
          const result=await target[key](...args);record(result);return result;
        };
        if(key==='first' || key==='raw')return (...args:[])=>{rows=null;return Reflect.apply(target[key],target,args);};
        return Reflect.get(target,key);
      },
    });
    originals.set(wrapped,original);
    return wrapped;
  }
  function track<T extends D1Database|D1DatabaseSession>(source:T):T {
    return new Proxy(source,{
      get(target,key){
        if(key==='prepare')return (sql:string)=>statement(target.prepare(sql));
        if(key==='batch')return async (batch:D1PreparedStatement[])=>{
          const results=await target.batch(batch.map(s=>originals.get(s)??s));results.forEach(record);return results;
        };
        if(key==='withSession' && 'withSession' in target && target.withSession)
          return (...args:Parameters<D1Database['withSession']>)=>track(target.withSession(...args));
        const value=Reflect.get(target,key);
        return typeof value==='function'?value.bind(target):value;
      }
    });
  }
  return {db:track(database),rows:()=>rows};
}
