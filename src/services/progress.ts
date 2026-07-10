// Live, operator-friendly progress state for menu actions.
//
// A menu click only opens the modeless progress window. The window then starts
// the real action with google.script.run and polls this per-user state while the
// action executes. This keeps progress visible even while Apps Script is busy.

namespace ProgressService {
  export type Status = 'prepared' | 'running' | 'waiting' | 'background' | 'success' | 'cancelled' | 'error';

  export interface ActionDescriptor {
    label: string;
    category: string;
    action: string;
  }

  export interface Report {
    title: string;
    detail?: string;
    hint?: string;
    percent?: number;
    step?: number;
    totalSteps?: number;
  }

  interface ProgressEvent {
    at: string;
    kind: 'info' | 'warning' | 'success' | 'error';
    title: string;
    detail: string;
  }

  export interface ProgressState {
    runId: string;
    action: string;
    label: string;
    category: string;
    status: Status;
    title: string;
    detail: string;
    hint: string;
    percent: number;
    step?: number;
    totalSteps?: number;
    startedAt: string;
    updatedAt: string;
    finishedAt?: string;
    events: ProgressEvent[];
  }

  interface ExecutionContext {
    runId: string;
    action: string;
  }

  const CACHE_PREFIX = 'shamrock-progress:';
  const CACHE_SECONDS = 21600;
  const MAX_EVENTS = 24;
  let executionContext: ExecutionContext | null = null;

  function cache(): GoogleAppsScript.Cache.Cache {
    return CacheService.getUserCache();
  }

  function cacheKey(runId: string): string {
    return `${CACHE_PREFIX}${runId}`;
  }

  function nowIso(): string {
    return new Date().toISOString();
  }

  function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function operatorSafeError(detail: string): string {
    return String(detail || 'Apps Script reported an unexpected error.')
      .replace(/https?:\/\/\S+/gi, '[link hidden]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email hidden]')
      .replace(/\b(?:id|spreadsheet|form|file)\s*[=:]\s*[A-Za-z0-9_-]{20,}\b/gi, '[resource ID hidden]')
      .replace(/\b[A-Za-z0-9_-]{35,}\b/g, '[resource ID hidden]')
      .substring(0, 700);
  }

  function read(runId: string): ProgressState | null {
    try {
      const raw = cache().get(cacheKey(runId));
      if (!raw) return null;
      return JSON.parse(raw) as ProgressState;
    } catch {
      return null;
    }
  }

  function write(state: ProgressState): void {
    try {
      cache().put(cacheKey(state.runId), JSON.stringify(state), CACHE_SECONDS);
    } catch {
      // Progress reporting is best-effort and must never break the real action.
    }
  }

  function addEvent(state: ProgressState, event: ProgressEvent): void {
    const last = state.events[state.events.length - 1];
    if (last && last.kind === event.kind && last.title === event.title && last.detail === event.detail) return;
    state.events.push(event);
    if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  }

  function defaultHint(descriptor: ActionDescriptor): string {
    const label = descriptor.label.toLowerCase();
    if (label.includes('transition')) return 'SHAMROCK saves transition checkpoints so a long run can resume safely.';
    if (label.startsWith('import')) return 'The file is validated before the authoritative admin sheet is changed.';
    if (label.startsWith('export')) return 'A new CSV will be created in Drive; existing sheet data is not changed.';
    if (label.includes('sync')) return 'Admin workbook data is authoritative; this refreshes the user-facing copy.';
    if (label.includes('attendance form')) return 'The existing response history is preserved before the form is rebuilt.';
    if (label.includes('format') || label.includes('protection')) return 'This changes presentation or edit access, not authoritative roster data.';
    if (label.includes('rebuild') || label.includes('refresh')) return 'SHAMROCK is regenerating a derived surface from current admin data.';
    if (label.includes('debug') || label.includes('dump') || label.includes('help')) return 'This is a read-only inspection unless the action explicitly says otherwise.';
    if (label.includes('pause')) return 'New automated propagation will wait until automations are resumed.';
    if (label.includes('resume')) return 'Deferred edits are reconciled before the refreshed views are published.';
    if (descriptor.category === 'Maintenance') return 'SHAMROCK is checking internal housekeeping state.';
    return 'You can leave this window open while SHAMROCK works.';
  }

  function htmlJson(value: string): string {
    return JSON.stringify(value).replace(/</g, '\\u003c');
  }

  function dialogHtml(descriptor: ActionDescriptor, runId: string): string {
    const actionJson = htmlJson(descriptor.action);
    const runIdJson = htmlJson(runId);
    return `<!doctype html>
<html>
<head>
  <base target="_top">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light; --green:#156b52; --green2:#2f8f70; --ink:#183029; --muted:#60736c; --line:#dce8e2; --wash:#f4f8f6; --warn:#a15c00; --bad:#b3261e; }
    * { box-sizing:border-box; }
    body { margin:0; padding:18px; color:var(--ink); background:#fff; font:13px/1.45 Arial,sans-serif; }
    .top { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .eyebrow { color:var(--green); font-size:10px; font-weight:700; letter-spacing:.11em; text-transform:uppercase; }
    h1 { margin:3px 0 0; font-size:18px; line-height:1.25; }
    .badge { flex:none; border-radius:999px; background:#e9f4ef; color:var(--green); padding:4px 9px; font-size:11px; font-weight:700; }
    .bar { height:8px; margin:16px 0 14px; overflow:hidden; border-radius:999px; background:#e5ece8; }
    .fill { width:2%; height:100%; border-radius:inherit; background:linear-gradient(90deg,var(--green),#5db590); transition:width .35s ease; }
    .current { padding:13px; border:1px solid var(--line); border-radius:10px; background:var(--wash); }
    .current h2 { margin:0 0 4px; font-size:15px; }
    .detail { color:#385049; min-height:20px; }
    .hint { margin-top:9px; padding-left:10px; border-left:3px solid #8dc9b2; color:var(--muted); }
    .meta { display:flex; justify-content:space-between; margin:10px 1px 0; color:var(--muted); font-size:11px; }
    .history-title { margin:16px 0 7px; color:var(--muted); font-size:10px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; }
    .history { max-height:190px; overflow:auto; border-top:1px solid var(--line); }
    .event { display:grid; grid-template-columns:10px 1fr auto; gap:8px; padding:8px 0; border-bottom:1px solid #edf2ef; }
    .dot { width:7px; height:7px; margin-top:5px; border-radius:50%; background:#7aa99a; }
    .event.warning .dot { background:var(--warn); }
    .event.error .dot { background:var(--bad); }
    .event.success .dot { background:var(--green2); }
    .event-title { font-weight:600; }
    .event-detail { color:var(--muted); font-size:11px; }
    .event-time { color:#84958f; font-size:10px; white-space:nowrap; }
    .footer { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top:13px; }
    .quiet { color:var(--muted); font-size:10px; }
    button { border:1px solid #b9cbc3; border-radius:7px; padding:6px 12px; color:var(--ink); background:white; cursor:pointer; }
    button:hover { background:var(--wash); }
  </style>
</head>
<body>
  <div class="top"><div><div class="eyebrow">SHAMROCK live progress</div><h1 id="actionLabel">Starting…</h1></div><div class="badge" id="badge">Preparing</div></div>
  <div class="bar"><div class="fill" id="fill"></div></div>
  <section class="current"><h2 id="title">Preparing the action</h2><div class="detail" id="detail">Opening a secure progress channel.</div><div class="hint" id="hint">Keep this window open for live updates.</div></section>
  <div class="meta"><span id="step">Stage-based progress</span><span id="elapsed">0s elapsed</span></div>
  <div class="history-title">Activity</div><div class="history" id="history"></div>
  <div class="footer"><span class="quiet">Closing this window will not stop the action.</span><button onclick="google.script.host.close()">Close</button></div>
  <script>
    const actionId = ${actionJson};
    const runId = ${runIdJson};
    let terminal = false;
    let startedAt = Date.now();
    let lastState = null;
    let missingReads = 0;
    const terminalStatuses = new Set(['success','cancelled','error','background']);
    const statusLabels = { prepared:'Preparing', running:'Running', waiting:'Waiting for you', background:'Continuing later', success:'Complete', cancelled:'Cancelled', error:'Needs attention' };

    function text(id, value) { document.getElementById(id).textContent = value || ''; }
    function render(state) {
      if (!state) {
        missingReads += 1;
        if (missingReads >= 5 && !terminal) {
          text('badge', 'Connection delayed');
          text('title', 'Live updates are temporarily unavailable');
          text('detail', 'The server action may still be running even though its short-term progress record could not be read.');
          text('hint', 'Do not start a duplicate action. Use Run ID ' + runId + ' in Audit Backend or Apps Script executions.');
        }
        return;
      }
      missingReads = 0;
      lastState = state;
      startedAt = new Date(state.startedAt).getTime() || startedAt;
      text('actionLabel', state.label);
      text('badge', statusLabels[state.status] || state.status);
      text('title', state.title);
      text('detail', state.detail);
      text('hint', state.hint);
      document.getElementById('fill').style.width = Math.max(2, Number(state.percent || 0)) + '%';
      text('step', state.step && state.totalSteps ? 'Stage ' + state.step + ' of ' + state.totalSteps : 'Stage-based progress');
      const history = document.getElementById('history');
      history.innerHTML = '';
      (state.events || []).slice().reverse().forEach(event => {
        const row = document.createElement('div'); row.className = 'event ' + event.kind;
        const dot = document.createElement('div'); dot.className = 'dot'; row.appendChild(dot);
        const copy = document.createElement('div');
        const t = document.createElement('div'); t.className = 'event-title'; t.textContent = event.title; copy.appendChild(t);
        if (event.detail) { const d = document.createElement('div'); d.className = 'event-detail'; d.textContent = event.detail; copy.appendChild(d); }
        row.appendChild(copy);
        const time = document.createElement('div'); time.className = 'event-time'; time.textContent = new Date(event.at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'}); row.appendChild(time);
        history.appendChild(row);
      });
      terminal = terminalStatuses.has(state.status);
    }

    function updateElapsed() { text('elapsed', Math.max(0, Math.round((Date.now() - startedAt) / 1000)) + 's elapsed'); }
    function poll() {
      google.script.run
        .withSuccessHandler(state => { render(state); updateElapsed(); if (!terminal) setTimeout(poll, 700); })
        .withFailureHandler(() => { if (!terminal) setTimeout(poll, 1400); })
        .getShamrockProgress(runId);
    }

    poll();
    google.script.run
      .withSuccessHandler(() => { setTimeout(poll, 100); })
      .withFailureHandler(error => {
        text('badge', 'Needs attention');
        text('title', 'The action stopped');
        text('detail', error && error.message ? error.message : 'Apps Script reported an unexpected error.');
        text('hint', 'Use the Run ID in Audit Backend or Apps Script logs if more detail is needed.');
        setTimeout(poll, 100);
      })
      .runShamrockProgressAction(actionId, runId);
    setInterval(updateElapsed, 1000);
  </script>
</body>
</html>`;
  }

  export function prepareAndShow(descriptor: ActionDescriptor, runId: string): boolean {
    const timestamp = nowIso();
    const state: ProgressState = {
      runId,
      action: descriptor.action,
      label: descriptor.label,
      category: descriptor.category,
      status: 'prepared',
      title: 'Preparing the action',
      detail: 'Opening a live progress channel and checking the current workbook context.',
      hint: defaultHint(descriptor),
      percent: 2,
      startedAt: timestamp,
      updatedAt: timestamp,
      events: [{ at: timestamp, kind: 'info', title: 'Action selected', detail: descriptor.label }],
    };
    write(state);

    try {
      const output = HtmlService.createHtmlOutput(dialogHtml(descriptor, runId)).setWidth(460).setHeight(590);
      SpreadsheetApp.getUi().showModelessDialog(output, 'SHAMROCK Live Progress');
      return true;
    } catch {
      return false;
    }
  }

  export function claim(action: string, runId: string): boolean {
    const lock = LockService.getUserLock();
    try {
      lock.waitLock(5000);
      const state = read(runId);
      if (!state || state.action !== action || state.status !== 'prepared') return false;
      state.status = 'running';
      state.title = 'Launching the requested action';
      state.detail = 'The live connection is ready. SHAMROCK is starting the first stage.';
      state.updatedAt = nowIso();
      write(state);
      return true;
    } catch {
      return false;
    } finally {
      try {
        lock.releaseLock();
      } catch {}
    }
  }

  export function withExecutionContext<T>(runId: string, action: string, fn: () => T): T {
    const previous = executionContext;
    executionContext = { runId, action };
    try {
      return fn();
    } finally {
      executionContext = previous;
    }
  }

  export function currentRunId(action: string): string | null {
    return executionContext?.action === action ? executionContext.runId : null;
  }

  export function cancellation(message: string): Error {
    const error = new Error(message);
    error.name = 'MenuActionCancelled';
    return error;
  }

  export function begin(report?: Report): void {
    if (!executionContext) return;
    const state = read(executionContext.runId);
    if (!state) return;
    const timestamp = nowIso();
    state.status = 'running';
    state.title = report?.title || 'Starting the requested work';
    state.detail = report?.detail || 'SHAMROCK is checking prerequisites before making changes.';
    state.hint = report?.hint || state.hint;
    state.percent = Math.max(state.percent, clampPercent(report?.percent ?? 5));
    state.updatedAt = timestamp;
    addEvent(state, { at: timestamp, kind: 'info', title: state.title, detail: state.detail });
    write(state);
  }

  export function report(report: Report): void {
    if (!executionContext) return;
    const state = read(executionContext.runId);
    if (!state || state.status === 'background' || state.status === 'error' || state.status === 'cancelled' || state.status === 'success') return;
    const timestamp = nowIso();
    state.status = 'running';
    state.title = report.title;
    state.detail = report.detail || '';
    if (report.hint) state.hint = report.hint;
    if (typeof report.percent === 'number') state.percent = Math.max(state.percent, clampPercent(report.percent));
    if (report.step) state.step = report.step;
    if (report.totalSteps) state.totalSteps = report.totalSteps;
    state.updatedAt = timestamp;
    addEvent(state, { at: timestamp, kind: 'info', title: state.title, detail: state.detail });
    write(state);
  }

  export function waiting(title: string, detail: string, hint?: string): void {
    if (!executionContext) return;
    const state = read(executionContext.runId);
    if (!state || state.status === 'background') return;
    const timestamp = nowIso();
    state.status = 'waiting';
    state.title = title;
    state.detail = detail;
    if (hint) state.hint = hint;
    state.updatedAt = timestamp;
    addEvent(state, { at: timestamp, kind: 'info', title, detail });
    write(state);
  }

  export function background(title: string, detail: string, hint?: string): void {
    if (!executionContext) return;
    const state = read(executionContext.runId);
    if (!state) return;
    const timestamp = nowIso();
    state.status = 'background';
    state.title = title;
    state.detail = detail;
    state.hint = hint || 'A continuation trigger will resume the saved work. Do not start a new run.';
    state.percent = Math.max(state.percent, 90);
    state.updatedAt = timestamp;
    state.finishedAt = timestamp;
    addEvent(state, { at: timestamp, kind: 'warning', title, detail });
    write(state);
  }

  export function complete(detail?: string): void {
    if (!executionContext) return;
    const state = read(executionContext.runId);
    if (!state || state.status === 'background') return;
    const timestamp = nowIso();
    state.status = 'success';
    state.title = 'Complete';
    state.detail = detail || `${state.label} finished successfully.`;
    state.hint = 'The authoritative audit record has been updated for this run.';
    state.percent = 100;
    state.updatedAt = timestamp;
    state.finishedAt = timestamp;
    addEvent(state, { at: timestamp, kind: 'success', title: 'Action completed', detail: state.detail });
    write(state);
  }

  export function cancel(detail: string): void {
    if (!executionContext) return;
    const state = read(executionContext.runId);
    if (!state) return;
    const timestamp = nowIso();
    state.status = 'cancelled';
    state.title = 'Cancelled';
    state.detail = 'No further work will be performed for this run.';
    state.hint = detail;
    state.updatedAt = timestamp;
    state.finishedAt = timestamp;
    addEvent(state, { at: timestamp, kind: 'warning', title: 'Action cancelled', detail });
    write(state);
  }

  export function fail(detail: string): void {
    if (!executionContext) return;
    const state = read(executionContext.runId);
    if (!state) return;
    const timestamp = nowIso();
    state.status = 'error';
    state.title = 'The action needs attention';
    state.detail = operatorSafeError(detail);
    state.hint = `Use Run ID ${state.runId} to find the matching Audit Backend row and technical logs.`;
    state.updatedAt = timestamp;
    state.finishedAt = timestamp;
    addEvent(state, { at: timestamp, kind: 'error', title: 'Action stopped', detail: state.detail });
    write(state);
  }

  export function get(runId: string): ProgressState | null {
    if (!/^[0-9a-f-]{20,}$/i.test(runId)) return null;
    return read(runId);
  }

  export function captureTechnicalLog(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
    if (!executionContext || level !== 'WARN') return;
    const state = read(executionContext.runId);
    if (!state || state.status !== 'running') return;

    const lower = message.toLowerCase();
    let title = '';
    let detail = '';
    if (lower.includes('validation')) {
      title = 'A validation rule needed a fallback';
      detail = 'SHAMROCK continued with a safe alternative and will verify the final surface.';
    } else if (lower.includes('protection')) {
      title = 'An optional protection step was skipped';
      detail = 'The action is continuing; review edit access afterward if the final result looks incomplete.';
    } else if (lower.includes('format')) {
      title = 'An optional formatting step was skipped';
      detail = 'Data work is continuing; the affected visual detail may need another formatting pass.';
    } else if (lower.includes('retry') || lower.includes('transient')) {
      title = 'Google asked SHAMROCK to retry';
      detail = 'This is usually temporary. The current step is being attempted again.';
    } else {
      return;
    }

    const timestamp = nowIso();
    addEvent(state, { at: timestamp, kind: 'warning', title, detail });
    state.updatedAt = timestamp;
    write(state);
  }
}
