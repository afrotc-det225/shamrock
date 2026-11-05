import { runLocalScenario } from './lib/v3-local-scenario.mjs';

const result = await runLocalScenario();
console.log('SHAMROCK D1 local demonstration — fictional data, no cloud resources');
console.log(JSON.stringify(result, null, 2));
