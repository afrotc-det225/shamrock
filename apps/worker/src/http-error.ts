/** Fixed, public-safe errors; never attach private SQL or command input. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
