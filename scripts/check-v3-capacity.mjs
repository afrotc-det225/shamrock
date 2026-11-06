import { runCapacityScenario } from './lib/v3-capacity-scenario.mjs';

const report = await runCapacityScenario();
console.log(JSON.stringify(report, null, 2));
if (!report.withinInvocationLimits) process.exitCode = 1;
