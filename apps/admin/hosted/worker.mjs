import handler from "./panel-handler.mjs";
import { panelControlStore } from "./control-store.mjs";
export { StagingPanelStore } from "./control-store-object.mjs";

// The deployed entry point always uses the independent, private control store.
// The legacy D1 binding is retained only for the bounded migration and rollback.
export default {
  fetch: (request, env) => handler.fetch(request, env, panelControlStore),
  scheduled: (event, env) => handler.scheduled(event, env, panelControlStore),
};
