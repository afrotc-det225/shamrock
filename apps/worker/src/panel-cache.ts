// Only signed, read-only panel routes enter this cache. A fresh primary bookmark
// detects even changes made outside the application (including access revocation).
import {attendanceDelta} from './panel-delta.js';
import type {PanelRevision} from '../../../packages/domain/src/panel-read.js';
import {HttpError} from './http-error.js';

type ReadEnv = { DB: D1Database; ENVIRONMENT: string; GENERATION: string; BRIDGE_KEY_ID: string };
async function primaryVersion(db: D1Database) {
  const session = db.withSession('first-primary');
  const {meta} = await session.prepare('SELECT 1').run();
  return {bookmark:session.getBookmark(),rowsRead:meta.rows_read};
}

async function cacheAddress(origin:string, path:string, parts:unknown[]) {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parts)));
  const hex=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  return new URL(path+hex,origin).href;
}

export async function cachedPanelRead(env: ReadEnv, url: URL, body: string, load: (bookmark?: string) => Promise<Response>): Promise<Response> {
  if (env.ENVIRONMENT !== 'staging' || typeof caches === 'undefined' || !env.DB.withSession) return load();
  const {bookmark:version,rowsRead} = await primaryVersion(env.DB);
  if (!version) return load();
  const address = await cacheAddress(url.origin,'/_private/read/',
    [env.ENVIRONMENT,env.GENERATION,env.BRIDGE_KEY_ID,url.pathname,body,version]);
  let edge: Cache;
  try {
    edge = await caches.open('shamrock-signed-panel-v1');
    const hit = await edge.match(address);
    if (hit) return new Response(hit.body,{headers:{'X-Shamrock-D1-Rows-Read':String(rowsRead),'Content-Type':'application/json; charset=utf-8',
      'Cache-Control':'no-store','Server-Timing':'panel;desc="edge"'}});
  } catch { return load(); }
  const response = await load(version);
  if (!response.ok || (await primaryVersion(env.DB)).bookmark !== version) return response;
  // Keep private records inside the named Worker cache; never cache the HTTP response publicly.
  try {
    await edge.put(address,new Response(response.clone().body,{headers:{'Cache-Control':'max-age=600'}}));
  } catch { /* Eviction and cache outages leave the fenced database response usable. */ }
  if (!response.headers.has('Server-Timing')) response.headers.set('Server-Timing','panel;desc="database"');
  return response;
}

type Tables = Record<string,string|number|null>;
type WingContext = {termId:string; principalId:string; revision:PanelRevision};
export type WingTableCache = (context:WingContext, load: () => Promise<Tables>) => Promise<Tables>;

// Only the Wing query invokes this, after resolving the real principal. Preview
// and Flight queries use actor-specific entries. The shared value contains only
// tables; scope, access and revision always come from the caller's own fence.
export function wingAttendanceCache(env: ReadEnv, url: URL, bookmark: string, onHit: (source:string) => void): WingTableCache {
  return async (context,load) => {
    const address = await cacheAddress(url.origin,'/_private/wing-attendance/',
      [env.ENVIRONMENT,env.GENERATION,env.BRIDGE_KEY_ID,bookmark]);
    let edge: Cache, hit: Response | undefined;
    try {
      edge = await caches.open('shamrock-wing-attendance-v1');
      hit = await edge.match(address);
    } catch { return load(); }
    if (hit) {
      const tables = await hit.json<Tables>();
      if ((await primaryVersion(env.DB)).bookmark !== bookmark)
        throw new HttpError(409,'SNAPSHOT_CHANGED','Reload the current attendance matrix.');
      onHit('wing-edge');
      return tables;
    }
    // Keep the last full base for ten minutes. Reuse it across a small sequence
    // of committed corrections; other audit operations require a fresh matrix.
    const slot = new URL('/_private/wing-base/'+encodeURIComponent(env.BRIDGE_KEY_ID)+'/'+env.GENERATION,url.origin).href;
    type Base = {termId:string; operations:number; administration:number; tables:Tables};
    let base:Base|undefined;
    try { base=await (await edge.match(slot))?.json<Base>(); } catch { /* Rebuild if unavailable. */ }
    let tables:Tables|undefined;
    if (base && base.termId===context.termId && base.administration===context.revision.administration &&
        base.operations<context.revision.operations && context.revision.operations-base.operations<=64) {
      const delta=await attendanceDelta(env,{environment:env.ENVIRONMENT,generation:Number(env.GENERATION),
        principalId:context.principalId,termId:context.termId,access:context.revision.access,
        from:base.operations,administration:base.administration});
      if (delta.available && delta.revision?.operations===context.revision.operations && delta.rows) {
        const corrections=JSON.parse(String(base.tables.corrections)).concat(delta.rows);
        const patched={...base.tables,corrections:JSON.stringify(corrections)};
        if (corrections.length<=10000 && Object.values(patched).reduce<number>((n,t)=>n+String(t).length,0)<=900000) {
          tables=patched;
          onHit('wing-delta');
        }
      }
    }
    const rebuilt=!tables;
    tables ??= await load();
    if ((await primaryVersion(env.DB)).bookmark === bookmark) {
      try {
        if (rebuilt) await edge.put(slot,new Response(JSON.stringify({termId:context.termId,
          operations:context.revision.operations,administration:context.revision.administration,tables}),
          {headers:{'Cache-Control':'max-age=600'}}));
        await edge.put(address,new Response(JSON.stringify(tables),{headers:{'Cache-Control':'max-age=600'}}));
      } catch { /* A full or unavailable cache still permits this authorized read. */ }
    }
    return tables;
  };
}
