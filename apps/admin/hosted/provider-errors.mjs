// Provider error text is used only for classification, never returned or logged.
// D1's generic error code also covers SQL failures; it is not a quota signal.
export function isDailyD1Limit(error) {
  const seen = new Set();
  for (let depth = 0; error && depth < 4 && !seen.has(error); depth++) {
    seen.add(error);
    const message = typeof error.message === "string" ? error.message : "";
    if (
      /\bD1(?:_ERROR)?\b/i.test(message) &&
      /\bdaily\b/i.test(message) &&
      /\b(?:read|write|written)\b/i.test(message) &&
      /\b(?:quota|limit)\b/i.test(message) &&
      /\b(?:exceeded|exceeds|reached|exhausted)\b/i.test(message)
    ) return true;
    error = error.cause;
  }
  return false;
}

export function dailyLimitResponse(error, url, now = Date.now()) {
  if (!isDailyD1Limit(error)) return null;
  const nextReset = (Math.floor(now / 86400000) + 1) * 86400000;
  const headers = { "Retry-After": String(Math.max(1, Math.ceil((nextReset - now) / 1000))) };
  if (url.pathname.startsWith("/auth/")) {
    headers.Location = "/?signin=SERVICE_LIMIT_REACHED";
    return new Response(null, { status: 303, headers });
  }
  return Response.json({ error: {
    code: "SERVICE_LIMIT_REACHED",
    message: "SHAMROCK has reached today's service limit. Please try again after midnight UTC.",
  } }, { status: 503, headers });
}
