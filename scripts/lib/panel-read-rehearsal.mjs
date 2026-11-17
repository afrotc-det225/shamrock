/** Aggregate-only budgets for an offline administrator read rehearsal. */
export const READ_PROFILES = ['initial', 'events', 'repeatEvents', 'unchanged'];
export function validateReadBudgets(value) {
  if (!value || value.version !== 1 || typeof value.principalId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.principalId) ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      !value.limits || Object.keys(value.limits).sort().join(',') !== [...READ_PROFILES].sort().join(','))
    throw Error('READ_REHEARSAL_CONFIG');
  for (const limit of Object.values(value.limits)) {
    if (!limit || Object.keys(limit).sort().join(',') !== 'maxBackendRequests,maxRowsRead' ||
        !Number.isSafeInteger(limit.maxRowsRead) || limit.maxRowsRead < 0 || limit.maxRowsRead > 5_000_000 ||
        !Number.isSafeInteger(limit.maxBackendRequests) || limit.maxBackendRequests < 1 || limit.maxBackendRequests > 1000)
      throw Error('READ_REHEARSAL_BUDGET');
  }
  return value;
}
export function evaluateReadBudgets(samples, config) {
  validateReadBudgets(config);
  if (samples.length !== READ_PROFILES.length || samples.some((s, i) => s.label !== READ_PROFILES[i]))
    throw Error('READ_REHEARSAL_SAMPLES');
  return samples.map(sample => ({ ...sample, budget: config.limits[sample.label], passed:
    sample.rowCountersAvailable && sample.localRowsWritten === 0 &&
    sample.localRowsRead <= config.limits[sample.label].maxRowsRead &&
    sample.backendRequests <= config.limits[sample.label].maxBackendRequests }));
}
