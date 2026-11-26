import {storeEnvironment} from "./site.mjs";
import { PanelError } from "../errors.mjs";

export const controlStoreName = (origin, generation) =>
  `shamrock-panel:${origin}:${generation}:v1`;

// The binding is private to the staging Worker. Browser requests never supply
// SQL, the object name, its environment, or its bootstrap payload.
export function panelControlStore(env) {
  env = storeEnvironment(env);
  let origin;
  try { origin = new URL(env.APP_ORIGIN); } catch {}
  const generation = Number(env.GENERATION);
  if (env.AUTH_STORE_VERSION !== "1" || env.ENVIRONMENT !== "staging" ||
      !origin || origin.protocol !== "https:" || origin.origin !== env.APP_ORIGIN ||
      !origin.hostname.includes("staging") || !Number.isSafeInteger(generation) || generation < 1 ||
      !env.AUTH_STORE?.getByName)
    throw new PanelError("AUTH_STORE_UNAVAILABLE", "Sign-in is temporarily unavailable. Please try again later.", 503);
  const stub = env.AUTH_STORE.getByName(controlStoreName(env.APP_ORIGIN, generation));
  const call = async (method, value) => {
    try { return await stub[method](value); }
    catch {
      // Provider or SQL details can contain private control-state context.
      throw new PanelError("AUTH_STORE_UNAVAILABLE", "Sign-in is temporarily unavailable. Please try again later.", 503);
    }
  };
  const statement = (sql, values = []) => ({
    sql, values,
    bind: (...next) => statement(sql, next),
    run: async () => (await call("execute", [{sql, values}]))[0],
    all: async () => (await call("execute", [{sql, values}]))[0],
    first: async () => (await call("execute", [{sql, values}]))[0].results[0] ?? null,
  });
  return {
    prepare: sql => statement(sql),
    batch: statements => call("execute", statements.map(({sql, values}) => ({sql, values}))),
    reserveAssistant: weight => call("reserveAssistant",weight),
    status: () => call("status"),
  };
}
