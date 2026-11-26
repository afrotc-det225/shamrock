import guide from "../README.md";
const operatorGuide = guide.split("## Operator guide\n")[1].split("## Hosted staging Assistant")[0].trim();
import handler from "./panel-handler.mjs";
import { panelControlStore } from "./control-store.mjs";
export { StagingPanelStore } from "./control-store-object.mjs";

// The deployed entry point always uses the independent, private control store.
// The legacy D1 binding is retained only for the bounded migration and rollback.
export default {
  async fetch(request,env) {
    if (!new URL(request.url).pathname.startsWith("/api/")) return handler.fetch(request,env,panelControlStore);
    let rows=0, measured=true;
    const backend={fetch:async upstream=>{
      const result=await env.BACKEND.fetch(upstream);
      const count=result.headers.get("X-Shamrock-D1-Rows-Read");
      if (/^\d+$/.test(count ?? "")) rows+=Number(count); else measured=false;
      return result;
    }};
    const response=await handler.fetch(request,{...env,operatorGuide,maintenanceSource:typeof __MAINTENANCE_SOURCE__ === "undefined" ? null : __MAINTENANCE_SOURCE__,BACKEND:backend},panelControlStore);
    if(response.ok) response.headers.set("X-Shamrock-D1-Rows-Read",measured?String(rows):"unknown");
    return response;
  },
  scheduled: (event, env) => handler.scheduled(event, env, panelControlStore),
};
