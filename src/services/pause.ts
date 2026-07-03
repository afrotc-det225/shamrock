// Central pause/resume flag for frontend/backend sync automations.

namespace PauseService {
  const KEY = Config.PROPERTY_KEYS.AUTOMATIONS_PAUSED;

  export function isPaused(): boolean {
    try {
      const raw = Config.getScriptProperty(KEY);
      return String(raw).toLowerCase() === 'true';
    } catch (err) {
      Log.warn(`Unable to read pause flag: ${err}`);
      return false;
    }
  }

  export function pause(reason?: string) {
    try {
      const payload = reason ? JSON.stringify({ paused: true, reason, at: new Date().toISOString() }) : 'true';
      Config.setScriptProperty(KEY, payload);
    } catch (err) {
      Log.warn(`Unable to set pause flag: ${err}`);
    }
  }

  export function resume(): boolean {
    const wasPaused = isPaused();
    try {
      Config.deleteScriptProperty(KEY);
    } catch (err) {
      Log.warn(`Unable to clear pause flag: ${err}`);
    }
    return wasPaused;
  }

  export function pauseInfo(): string {
    try {
      const raw = Config.getScriptProperty(KEY);
      if (!raw) return 'not paused';
      if (raw === 'true') return 'paused';
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.reason) return `paused: ${parsed.reason}`;
      } catch {
        // fall through
      }
      return 'paused';
    } catch (err) {
      Log.warn(`Unable to read pause info: ${err}`);
      return 'unknown';
    }
  }
}
