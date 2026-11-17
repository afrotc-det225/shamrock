// Inspect only known provider wording; never return or log the original error.
// D1_ERROR alone also describes SQL, storage and transient failures.
export function isDailyD1Limit(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let depth = 0; error && typeof error === 'object' && depth < 4 && !seen.has(error); depth++) {
    seen.add(error);
    const candidate = error as { message?: unknown; cause?: unknown };
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    if (/\bD1(?:_ERROR)?\b/i.test(message) && /\bdaily\b/i.test(message)
      && /\b(?:read|write|written)\b/i.test(message) && /\b(?:quota|limit)\b/i.test(message)
      && /\b(?:exceeded|exceeds|reached|exhausted)\b/i.test(message)) return true;
    error = candidate.cause;
  }
  return false;
}

export function dailyD1LimitResponse(error: unknown, now = Date.now()): Response | null {
  if (!isDailyD1Limit(error)) return null;
  const nextReset = (Math.floor(now / 86400000) + 1) * 86400000;
  return new Response(JSON.stringify({ error: {
    code: 'SERVICE_LIMIT_REACHED',
    message: "SHAMROCK's database has reached its daily limit. Please try again after midnight UTC.",
  } }), { status: 503, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'retry-after': String(Math.max(1, Math.ceil((nextReset - now) / 1000))),
  } });
}

// These POST routes only read records/authority; POST keeps scoped selectors out
// of URLs. Unknown routes conservatively retain the mutation receipt guidance.
const readPaths = new Set([
  '/v1/admin/catalog', '/v1/admin/closeout/status', '/v1/admin/transitions/status',
  '/v1/admin/transitions/archive/page', '/v1/admin/notifications/status',
  '/v1/admin/notifications/rehearsal/status', '/v1/admin/permissions/status',
  '/v1/admin/event-rosters/preview', '/v1/admin/directory/review-authorize',
  '/v1/admin/history/list', '/v1/admin/history/requests', '/v1/admin/history/summary',
  '/v1/admin/history/page', '/v1/admin/history/read', '/v1/admin/effects/availability',
  '/v1/admin/snapshot', '/v1/admin/snapshot/page', '/v1/admin/panel/page',
  '/v1/admin/panel/access', '/v1/admin/panel/authorize',
  '/v1/admin/panel/view-as/page', '/v1/admin/panel/view-as/access',
]);

export function isRecordRead(request: Request): boolean {
  if (request.method === 'GET') return true;
  const url = new URL(request.url);
  return request.method === 'POST' && !url.search && readPaths.has(url.pathname);
}
