// Checked against official provider documentation on 2026-11-05. These are
// comparison thresholds, not account settings or a promise of future pricing.
export const FREE_LIMITS = Object.freeze({
  workerRequestsPerDay: 100_000, workerCpuMs: 10,
  d1QueriesPerInvocation: 50, d1ParametersPerStatement: 100, d1SqlBytes: 100_000,
  d1RowsReadPerDay: 5_000_000, d1RowsWrittenPerDay: 100_000,
  d1DatabaseBytes: 500_000_000,
});

// Instrument actual Worker SQL against disposable Miniflare D1. Deliberately
// omit SQL, bindings, response bodies and identities from the report.
export function instrumentDatabase(db) {
  let active;
  const wrappers = new WeakMap();
  function begin(label) {
    if (active) throw new Error('Capacity samples must run sequentially.');
    active = { label, d1Calls: 0, statements: 0, maxParameters: 0, maxSqlBytes: 0,
      localRowsRead: 0, localRowsWritten: 0, rowCountersAvailable: true };
  }
  function metadata(result) {
    const meta = result?.meta;
    for (const [field, key] of [['rows_read', 'localRowsRead'], ['rows_written', 'localRowsWritten']]) {
      if (!Number.isSafeInteger(meta?.[field]) || meta[field] < 0) active.rowCountersAvailable = false;
      else active[key] += meta[field];
    }
  }
  function counted(statements) {
    if (!active) throw new Error('Database access outside a capacity sample.');
    active.d1Calls++;
    active.statements += statements.length;
    for (const statement of statements) {
      active.maxParameters = Math.max(active.maxParameters, statement.parameters);
      active.maxSqlBytes = Math.max(active.maxSqlBytes, Buffer.byteLength(statement.sql));
    }
  }
  function wrap(native, sql, parameters = 0) {
    const details = { native, sql, parameters };
    const wrapper = {
      bind(...values) { return wrap(native.bind(...values), sql, values.length); },
      async all() { counted([details]); const result = await native.all(); metadata(result); return result; },
      async run() { counted([details]); const result = await native.run(); metadata(result); return result; },
      async first(column) {
        // D1 .first() omits metadata. Execute the identical SQL through .all()
        // and reproduce first-row/column semantics for this measurement harness.
        const result = await wrapper.all();
        const first = result.results[0] ?? null;
        return first === null || column === undefined ? first : first[column];
      },
    };
    wrappers.set(wrapper, details);
    return wrapper;
  }
  return {
    db: {
      prepare(sql) { return wrap(db.prepare(sql), sql); },
      async batch(statements) {
        const details = statements.map(statement => wrappers.get(statement));
        if (details.some(value => !value)) throw new Error('Uninstrumented D1 statement.');
        // Cloudflare counts an entire D1 batch as ONE invocation query.
        counted(details);
        const results = await db.batch(details.map(value => value.native));
        results.forEach(metadata);
        return results;
      },
    }, begin,
    end() {
      if (!active) throw new Error('No capacity sample is active.');
      const result = active; active = undefined;
      return { ...result, withinInvocationLimits:
        result.d1Calls <= FREE_LIMITS.d1QueriesPerInvocation
        && result.maxParameters <= FREE_LIMITS.d1ParametersPerStatement
        && result.maxSqlBytes <= FREE_LIMITS.d1SqlBytes };
    },
  };
}

export function summarizeCapacity(samples) {
  if (!samples.length) throw new Error('At least one measured sample is required.');
  return {
    mode: 'local-fictional-data', productionReady: false,
    measurement: 'Worker handler in Node; real SQL in disposable Miniflare D1; first() measured using all().',
    limitsCheckedOn: '2026-11-05', limits: FREE_LIMITS,
    samples,
    withinInvocationLimits: samples.every(sample => sample.withinInvocationLimits),
    dailyUsage: null, hostedCpuMs: null,
    limitations: [
      'Local row counters and SQL shape are evidence for this fixture, not hosted billing or CPU measurements.',
      'No daily forecast: actual command mix, retries, polling, imports, indexes and retained history must be measured.',
      'This does not verify the account plan, Google quotas, complete feature parity or production readiness.',
    ],
  };
}
