import React, { useEffect, useState } from "react";
import { api } from "./api";

/** Component-local receipt state: no eager fetch or browser-persistent cache. */
export function useReceipts({ history, receiptsDeferred, reportingTime, captureKey, enabled = true }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState(null);
  const key = JSON.stringify([captureKey, reportingTime, attempt]);
  useEffect(() => {
    if (!enabled || !receiptsDeferred) return;
    const controller = new AbortController();
    setState({ key, rows: null, error: "" });
    api("/receipts", undefined, { signal: controller.signal }).then(result => {
      if (result.contractVersion !== "admin-receipts-v1" || !Array.isArray(result.receipts))
        throw new Error("Saved changes could not be verified. Please retry.");
      if (!controller.signal.aborted) setState({ key, rows: result.receipts, error: "" });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ key, rows: null, error: error.message });
    });
    return () => controller.abort();
  }, [enabled, receiptsDeferred, key]);
  const current = state?.key === key ? state : null;
  const rows = !enabled ? null : receiptsDeferred ? current?.rows ?? null : Array.isArray(history) ? history : null;
  const error = enabled && receiptsDeferred ? current?.error || "" : "";
  return { rows, error, loading: enabled && receiptsDeferred && rows === null && !error,
    retry: () => setAttempt(value => value + 1) };
}

export function ReceiptStatus({ receipt }) {
  if (receipt.loading) return <span className="page-transfer" role="status">Loading saved changes…</span>;
  if (receipt.error) return <div className="error" role="alert">
    {receipt.error} <button onClick={receipt.retry}>Retry loading changes</button>
  </div>;
  return null;
}
