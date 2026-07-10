// Lightweight logging helpers for Apps Script.

namespace Log {
  function emit(level: 'INFO' | 'WARN' | 'ERROR', message: string) {
    const line = `[${level}] ${message}`;
    // Use a single sink to avoid duplicate log lines in Apps Script executions.
    // console.log is supported in V8; fall back to Logger if needed.
    try {
      console.log(line);
    } catch (err) {
      Logger.log(line);
    }
    try {
      ProgressService.captureTechnicalLog(level, message);
    } catch {
      // Live progress is best-effort and must not affect logging or real work.
    }
  }

  export function info(message: string) {
    emit('INFO', message);
  }

  export function warn(message: string) {
    emit('WARN', message);
  }

  export function error(message: string) {
    emit('ERROR', message);
  }
}
