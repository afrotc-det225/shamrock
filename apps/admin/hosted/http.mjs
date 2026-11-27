import { PanelError } from "../errors.mjs";
export async function boundedJson(message, max = 65536) {
  const reader = message.body?.getReader();
  if (!reader) throw new PanelError("INVALID_REQUEST", "The request is empty.");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new PanelError(
          "TOO_LARGE",
          "Please make a smaller request.",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PanelError("INVALID_REQUEST", "The request could not be read.");
  }
}
export const json = (data, status = 200) => Response.json(data, { status });
export function originCheck(request, origin) {
  if (
    request.headers.get("origin") !== origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new PanelError(
      "INVALID_ORIGIN",
      "Reload SHAMROCK before saving.",
      403,
    );
}
export function secure(response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: https://drive.google.com https://*.googleusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  return new Response(response.body, { status: response.status, headers });
}
