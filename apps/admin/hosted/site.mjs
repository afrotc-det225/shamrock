// The public origin is distinct from the immutable keys used for existing sessions and receipts.
export const siteOrigin = "https://shamrock.det225.workers.dev";

export function isUnifiedSite(env) {
  return env.APP_ORIGIN === siteOrigin && env.BACKEND_SERVICE_NAME === "shamrock" &&
    env.BACKEND_ORIGIN === siteOrigin && env.STAGING_DATASET === "real" && env.ENVIRONMENT === "staging";
}

export function storeEnvironment(env) {
  if (!isUnifiedSite(env)) return env;
  return { ...env, APP_ORIGIN: env.AUTH_STORE_ORIGIN };
}

// A rehearsal signer never receives the real database, caches, or panel bindings.
// The API verifies the signature against the selected key before reading records.
export function recordsEnvironment(request, env) {
  const rehearsalKey = env.REHEARSAL_KEY_ID;
  if (rehearsalKey && rehearsalKey === env.BRIDGE_KEY_ID) throw new Error("Conflicting adapter key IDs");
  if (rehearsalKey && request.headers.get("x-shamrock-key-id") === rehearsalKey) {
    return {
      DB: env.REHEARSAL_DB, ENVIRONMENT: env.ENVIRONMENT, GENERATION: env.REHEARSAL_GENERATION,
      BRIDGE_KEY_ID: rehearsalKey, BRIDGE_SECRET: env.REHEARSAL_SECRET,
      OWNER_MAIL_REHEARSAL_ENABLED: env.REHEARSAL_MAIL_ENABLED,
      OWNER_MAIL_REHEARSAL_EMAIL: env.REHEARSAL_MAIL_EMAIL,
      OWNER_MAIL_REHEARSAL_PRINCIPAL: env.REHEARSAL_MAIL_PRINCIPAL,
    };
  }
  return {
    DB: env.DB, WING_MATRICES: env.WING_MATRICES, ENVIRONMENT: env.ENVIRONMENT,
    GENERATION: env.GENERATION, BRIDGE_KEY_ID: env.BRIDGE_KEY_ID, BRIDGE_SECRET: env.BRIDGE_SECRET,
  };
}
