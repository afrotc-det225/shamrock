import { createRemoteJWKSet, jwtVerify } from "jose";
import {schoolWingAccess} from "./wing-access.mjs";
import {isUnifiedSite} from "./site.mjs";
import { HostedBackend } from "./backend.mjs";
import { schoolForEmail, sealSchoolEmail, readSchoolEmail } from "./school-account.mjs";
import { PanelError } from "../errors.mjs";
import { boundedJson, originCheck, json } from "./http.mjs";
import { previewFromSession, previewResponse } from "./view-as.mjs";
const encoder = new TextEncoder();
const keys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { timeoutDuration: 10000 },
);
export const sha = async (text) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const b64 = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const cookie = (request, name) => {
  const matches = (request.headers.get("cookie") || "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(name + "="));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : "";
};
const setCookie = (name, value, seconds) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
const redirect = (location, cookies = []) => {
  const headers = new Headers({ location });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 303, headers });
};
export async function verifyGoogleIdentity(token, clientId, nonce, jwks = keys) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId,
    algorithms: ["RS256"],
    clockTolerance: 30,
    maxTokenAge: "10m",
  });
  if (
    typeof payload.sub !== "string" ||
    payload.sub.length > 255 ||
    !payload.sub ||
    payload.nonce !== nonce ||
    payload.email_verified !== true ||
    typeof payload.exp !== "number" ||
    (payload.azp !== undefined && payload.azp !== clientId)
  )
    throw new PanelError(
      "INVALID_IDENTITY",
      "Google sign-in could not be verified.",
      401,
    );
  const email = typeof payload.email === "string" ? payload.email : "";
  // Only the signed, verified claim may match a privately reviewed invitation.
  // Missing email does not invalidate an already-bound Google subject.
  const emailHash = email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? await sha(email.toLowerCase()) : null;
  const domain = email.toLowerCase().split("@")[1];
  const schoolEmail = emailHash && typeof payload.hd === "string" && payload.hd.toLowerCase() === domain && schoolForEmail(email)
    ? email.toLowerCase() : null;
  const ownedEmail = emailHash && (domain === "gmail.com" || (typeof payload.hd === "string" && payload.hd.toLowerCase() === domain)) ? email.toLowerCase() : null;
  return { subject: payload.sub, emailHash, schoolEmail, ownedEmail, claimedSchoolEmail: emailHash && schoolForEmail(email) ? email.toLowerCase() : null };
}
export async function verifyGoogleToken(token, clientId, nonce, jwks = keys) {
  return (await verifyGoogleIdentity(token, clientId, nonce, jwks)).subject;
}
async function resolveLoginBinding(env, identity, now) {
  const existing = await env.PANEL_DB.prepare(
    "SELECT principal_id FROM identity_bindings WHERE google_sub=? AND active=1",
  ).bind(identity.subject).first();
  if (existing || !identity.emailHash) return existing;
  // The two writes and readback share one control-store transaction. An invitation never
  // replaces a subject binding, reactivates one, or adds a login to a bound principal.
  const results = await env.PANEL_DB.batch([
    env.PANEL_DB.prepare(`INSERT INTO identity_bindings(google_sub,principal_id,active)
      SELECT ?,i.principal_id,1 FROM login_invitations i
      WHERE i.email_sha256=? AND i.created<=? AND i.expires>? AND i.consumed_subject IS NULL
      AND NOT EXISTS(SELECT 1 FROM identity_bindings b WHERE b.google_sub=? OR b.principal_id=i.principal_id)
      AND (SELECT COUNT(*) FROM identity_bindings)<2000
      ON CONFLICT(google_sub) DO NOTHING`)
      .bind(identity.subject,identity.emailHash,now,now,identity.subject),
    env.PANEL_DB.prepare(`UPDATE login_invitations SET consumed_subject=?,consumed_at=?
      WHERE email_sha256=? AND created<=? AND expires>? AND consumed_subject IS NULL
      AND EXISTS(SELECT 1 FROM identity_bindings b WHERE b.google_sub=? AND b.principal_id=login_invitations.principal_id AND b.active=1)`)
      .bind(identity.subject,now,identity.emailHash,now,now,identity.subject),
    env.PANEL_DB.prepare(`SELECT b.principal_id FROM identity_bindings b JOIN login_invitations i
      ON i.principal_id=b.principal_id AND i.consumed_subject=b.google_sub
      WHERE b.google_sub=? AND b.active=1 AND i.email_sha256=?`)
      .bind(identity.subject,identity.emailHash),
  ]);
  return results[2].results[0] || null;
}
export async function session(request, env) {
  const token = cookie(request, "__Host-shamrock-v2");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new PanelError("SIGN_IN_REQUIRED", "Sign in to SHAMROCK.", 401);
  const row = await env.PANEL_DB.prepare(
    "SELECT s.token_hash,s.google_sub,s.csrf,s.expires,b.principal_id,COALESCE(p.person_id,i.person_id) AS preview_person_id,COALESCE(p.entry_audit_id,i.entry_audit_id) AS preview_entry_audit_id,CASE WHEN p.person_id IS NOT NULL THEN p.status WHEN i.person_id IS NOT NULL THEN 'starting' ELSE NULL END AS preview_status FROM sessions s JOIN identity_bindings b ON b.google_sub=s.google_sub LEFT JOIN session_previews p ON p.token_hash=s.token_hash LEFT JOIN session_preview_intents i ON i.token_hash=s.token_hash AND i.exit_audit_id IS NULL WHERE s.token_hash=? AND s.expires>? AND b.active=1",
  )
    .bind(await sha(token), Date.now())
    .first();
  if (!row)
    throw new PanelError(
      "SIGN_IN_REQUIRED",
      "Your session ended. Sign in again.",
      401,
    );
  row.schoolEmail = await readSchoolEmail(cookie(request,"__Host-shamrock-school"),env,row.token_hash);
  if (row.principal_id.startsWith("school.") && (!row.schoolEmail || row.principal_id !== "school." + await sha(row.schoolEmail)))
    throw new PanelError("SIGN_IN_REQUIRED","Sign in again with your school account.",401);
  if(row.schoolEmail && isUnifiedSite(env) && /^(school|google)\./.test(row.principal_id)){
    const path=new URL(request.url).pathname;
    if(!["/api/cadet","/auth/logout"].includes(path)){
      const suffix=await sha(row.schoolEmail);
      const school="school."+suffix;
      const google=row.principal_id==="google."+suffix ? row.principal_id : null;
      if(row.principal_id===school || google){
        row.wingAccess=await schoolWingAccess(env.DB,school,row.schoolEmail,google).catch(()=>false);
        if(row.wingAccess) row.principal_id=school;
      }
    }
  }
  return row;
}
export async function csrfCheck(request, env, bodySession) {
  originCheck(request, env.APP_ORIGIN);
  const value = request.headers.get("x-shamrock-csrf") || "";
  // Compare fixed-size digests in Workers' constant-time primitive.
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(value) ||
    !crypto.subtle.timingSafeEqual(
      encoder.encode(value),
      encoder.encode(bodySession.csrf),
    )
  )
    throw new PanelError(
      "INVALID_SESSION",
      "Reload SHAMROCK before saving.",
      403,
    );
}
export async function authRoute(
  request,
  env,
  { fetcher = fetch, verify = verifyGoogleIdentity } = {},
) {
  const url = new URL(request.url),
    now = Date.now();
  if (url.pathname === "/auth/login" && request.method === "GET") {
    const previous = cookie(request, "__Host-shamrock-v2");
    if (/^[A-Za-z0-9_-]{43}$/.test(previous)) {
      try {
        await session(request, env);
        return redirect(env.APP_ORIGIN + "/");
      } catch (error) {
        if (error.code !== "SIGN_IN_REQUIRED") throw error;
      }
      await env.PANEL_DB.prepare("DELETE FROM sessions WHERE token_hash=?")
        .bind(await sha(previous))
        .run();
    }
    const bucket = await sha(
      `${env.APP_ORIGIN}|${request.headers.get("cf-connecting-ip") || "unknown"}|${Math.floor(now / 600000)}`,
    );
    const limit = await env.PANEL_DB.prepare(
      "INSERT INTO auth_limits SELECT ?,1,? WHERE (SELECT COUNT(*) FROM auth_limits)<2000 OR EXISTS(SELECT 1 FROM auth_limits WHERE bucket=?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts",
    )
      .bind(bucket, now + 600000, bucket)
      .first();
    if (!limit || limit.attempts > 10)
      throw new PanelError(
        "SIGN_IN_LIMIT",
        "Please wait a few minutes before signing in again.",
        429,
      );
    const state = random(),
      browser = random(),
      verifier = random(),
      nonce = random();
    const inserted = await env.PANEL_DB.prepare(
      "INSERT INTO oauth_states SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM oauth_states)<2000",
    )
      .bind(await sha(state), await sha(browser), verifier, nonce, now + 600000)
      .run();
    if (!inserted.meta.changes)
      throw new PanelError(
        "SIGN_IN_LIMIT",
        "Sign-in is busy. Please try again later.",
        429,
      );
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    const challenge = b64(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
      ),
    );
    auth.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: env.APP_ORIGIN + "/auth/callback",
      response_type: "code",
      scope: "openid email",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return redirect(auth.toString(), [
      setCookie("__Host-shamrock-auth-v2", browser, 600),
      setCookie("__Host-shamrock-v2", "", 0),
    ]);
  }
  if (url.pathname === "/auth/callback" && request.method === "GET") {
    const state = url.searchParams.get("state"),
      browser = cookie(request, "__Host-shamrock-auth-v2");
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(state || "") ||
      !/^[A-Za-z0-9_-]{43}$/.test(browser)
    )
      throw new PanelError(
        "SIGN_IN_EXPIRED",
        "Please start sign-in again.",
        401,
      );
    const saved = await env.PANEL_DB.prepare(
      "DELETE FROM oauth_states WHERE state_hash=? AND browser_hash=? AND expires>? RETURNING verifier,nonce",
    )
      .bind(await sha(state), await sha(browser), now)
      .first();
    if (!saved)
      throw new PanelError(
        "SIGN_IN_EXPIRED",
        "Please start sign-in again.",
        401,
      );
    const code = url.searchParams.get("code");
    if (
      !code ||
      code.length > 4096 ||
      url.searchParams.getAll("code").length !== 1 ||
      url.searchParams.getAll("state").length !== 1
    )
      throw new PanelError(
        "SIGN_IN_CANCELLED",
        "Sign-in was not completed.",
        401,
      );
    const response = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env.APP_ORIGIN + "/auth/callback",
        grant_type: "authorization_code",
        code_verifier: saved.verifier,
      }),
    });
    if (!response.ok)
      throw new PanelError(
        "SIGN_IN_FAILED",
        "Google sign-in did not complete. Please try again.",
        401,
      );
    const tokens = await boundedJson(response, 32768);
    let identity;
    try {
      identity = await verify(
        tokens.id_token,
        env.GOOGLE_CLIENT_ID,
        saved.nonce,
      );
    } catch {
      throw new PanelError(
        "INVALID_IDENTITY",
        "Google sign-in could not be verified.",
        401,
      );
    }
    let binding = await resolveLoginBinding(env, identity, Date.now());
    // A custodian can bind an independently confirmed Google subject for a partner school.
    // Only that existing principal may open the matching Directory record.
    if (!identity.schoolEmail && identity.claimedSchoolEmail && binding && !binding.principal_id.startsWith("school.")) {
      const reviewed = await env.PANEL_DB.prepare("SELECT principal_id FROM identity_bindings WHERE google_sub=? AND active=1 AND NOT EXISTS(SELECT 1 FROM login_invitations WHERE consumed_subject=?)")
        .bind(identity.subject, identity.subject).first();
      if (reviewed?.principal_id === binding.principal_id) identity.schoolEmail = identity.claimedSchoolEmail;
    }
    if (!identity.schoolEmail && identity.ownedEmail && (!binding || binding.principal_id.startsWith("school."))) {
      const principalId="google."+identity.emailHash;
      const backend=new HostedBackend(env,principalId);
      const known=await backend.post("/v1/cadet/known",{...backend.identity(),email:identity.ownedEmail});
      if(known.known===true) identity.schoolEmail=identity.ownedEmail;
    }
    if (!binding && identity.schoolEmail) {
      const schoolId = "school." + identity.emailHash;
      binding = await env.PANEL_DB.prepare(`INSERT INTO identity_bindings(google_sub,principal_id,active)
        SELECT ?,?,1 WHERE NOT EXISTS(SELECT 1 FROM identity_bindings WHERE google_sub=? OR principal_id IN (?,?))
        AND NOT EXISTS(SELECT 1 FROM login_invitations WHERE email_sha256=?)
        AND (SELECT COUNT(*) FROM identity_bindings)<2000 ON CONFLICT DO NOTHING RETURNING principal_id`)
        .bind(identity.subject,schoolId,identity.subject,schoolId,"google."+identity.emailHash,identity.emailHash).first();
    }
    if (!binding || (binding.principal_id.startsWith("school.") && (!identity.schoolEmail || binding.principal_id !== "school."+identity.emailHash)))
      throw new PanelError(
        "ACCESS_NOT_GRANTED",
        identity.claimedSchoolEmail && !identity.schoolEmail ? "Ask your SHAMROCK administrator to confirm this Google account for your school address." : "This Google account does not have SHAMROCK access. Contact your administrator.",
        403,
      );
    const token = random(),
      csrf = random(),
      subject = identity.subject;
    const savedSession = await env.PANEL_DB.prepare(
      "INSERT INTO sessions SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM sessions)<2000 AND (SELECT COUNT(*) FROM sessions WHERE google_sub=?)<20",
    )
      .bind(await sha(token), subject, csrf, now + 8 * 3600000, subject)
      .run();
    if (!savedSession.meta.changes)
      throw new PanelError(
        "SIGN_IN_LIMIT",
        "Too many sessions are open. Sign out on another device or try again later.",
        429,
      );
    return redirect("/", [
      setCookie("__Host-shamrock-v2", token, 8 * 3600),
      setCookie("__Host-shamrock-school", identity.schoolEmail ? await sealSchoolEmail(identity.schoolEmail,env,await sha(token)) : "", identity.schoolEmail ? 8*3600 : 0),
      setCookie("__Host-shamrock-auth-v2", "", 0),
    ]);
  }
  if (url.pathname === "/api/session" && request.method === "POST") {
    originCheck(request, env.APP_ORIGIN);
    const current = await session(request, env);
    return json({ authenticated: true, hosted: true, cadetWorkspace:!!current.schoolEmail, schoolWingAccess:current.wingAccess===true, schoolLogin:current.principal_id.startsWith("school.") && !current.wingAccess, csrf: current.csrf, viewAs: previewResponse(previewFromSession(current)) });
  }
  if (url.pathname === "/auth/logout" && request.method === "POST") {
    const current = await session(request, env);
    await csrfCheck(request, env, current);
    await env.PANEL_DB.prepare("DELETE FROM sessions WHERE token_hash=?")
      .bind(current.token_hash)
      .run();
    return new Response(JSON.stringify({ signedOut: true }), {
      headers: {
        "content-type": "application/json",
        "Set-Cookie": setCookie("__Host-shamrock-v2", "", 0),
      },
    });
  }
  return null;
}
