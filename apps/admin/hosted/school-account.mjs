export { schoolForEmail } from "../../../.build/v3/packages/domain/src/school-account.js";
import { EncryptJWT, jwtDecrypt } from "jose";
import { createHash } from "node:crypto";
const key = (env) =>
  createHash("sha256")
    .update("SHAMROCK cadet session\0")
    .update(env.GOOGLE_CLIENT_SECRET)
    .digest();

export function sealSchoolEmail(email, env, tokenHash) {
  return new EncryptJWT({ email })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setAudience(env.APP_ORIGIN)
    .setSubject(tokenHash)
    .setExpirationTime("8h")
    .encrypt(key(env));
}
export async function readSchoolEmail(value, env, tokenHash) {
  if (!value || value.length > 1600) return null;
  try {
    const { payload } = await jwtDecrypt(value, key(env), {
      audience: env.APP_ORIGIN,
      subject: tokenHash,
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}
