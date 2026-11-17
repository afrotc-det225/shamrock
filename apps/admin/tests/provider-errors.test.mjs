import test from "node:test";
import assert from "node:assert/strict";
import { dailyLimitResponse, isDailyD1Limit } from "../hosted/provider-errors.mjs";

const quotaError = () => new Error("Your account has exceeded D1's free tier daily row read limit. Private provider details.");
const atNoon = Date.UTC(2026, 10, 17, 12);

test("daily D1 limits are distinct from Google identity and ordinary database errors", () => {
  assert.equal(isDailyD1Limit(quotaError()), true);
  assert.equal(isDailyD1Limit(new Error("D1_ERROR: daily write quota exhausted")), true);
  assert.equal(isDailyD1Limit(new Error("Database operation failed", { cause: quotaError() })), true);
  for (const error of [
    undefined, new Error("invalid_grant"), new Error("Google sign-in failed"),
    new Error("D1_ERROR: database storage limit exceeded"),
    new Error("D1_ERROR: too many requests"),
    new Error("D1_ERROR: SQL syntax error"), { code: 7500 },
  ]) assert.equal(isDailyD1Limit(error), false);
  const cycle = new Error("ordinary failure");
  cycle.cause = cycle;
  assert.equal(isDailyD1Limit(cycle), false);
});

test("both login and callback quota failures use a private, non-retrying redirect", async () => {
  for (const path of ["/auth/login", "/auth/callback?code=private-code&state=private-state"]) {
    const response = dailyLimitResponse(quotaError(), new URL(path, "https://staging.example.invalid"), atNoon);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/?signin=SERVICE_LIMIT_REACHED");
    assert.equal(response.headers.get("retry-after"), "43200");
    assert.equal(await response.text(), "");
  }
});

test("API quota failure is unavailable until next UTC reset without provider details", async () => {
  const url = new URL("https://staging.example.invalid/api/state");
  const response = dailyLimitResponse(quotaError(), url, atNoon);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "43200");
  assert.deepEqual(await response.json(), { error: {
    code: "SERVICE_LIMIT_REACHED",
    message: "SHAMROCK has reached today's service limit. Please try again after midnight UTC.",
  } });
  assert.equal(dailyLimitResponse(quotaError(), url, atNoon + 43199999).headers.get("retry-after"), "1");
  assert.equal(dailyLimitResponse(quotaError(), url, atNoon + 43200000).headers.get("retry-after"), "86400");
  assert.equal(dailyLimitResponse(new Error("invalid_grant"), url), null);
});
