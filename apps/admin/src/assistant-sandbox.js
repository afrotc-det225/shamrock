import { transform } from "sucrase";
import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { regressionCases } from "./assistant-cases.mjs";
import { runnable } from "../hosted/maintenance.mjs";

function equal(a,b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a)!==Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b,k) && equal(a[k],b[k]));
}
function check(engine, source, fn, test) {
  const rt = engine.newRuntime();
  rt.setMemoryLimit(4 * 1024 * 1024);
  rt.setMaxStackSize(128 * 1024);
  const deadline = performance.now() + 150;
  rt.setInterruptHandler(() => performance.now() >= deadline);
  const vm = rt.newContext();
  try {
    // Only pure entry points are exercised. A dependency access fails explicitly.
    const code = "const exports={}; const require=()=>new Proxy({}, {get(){throw Error('Dependency unavailable')}});\n"
      + transform(source,{transforms:["typescript","imports"]}).code;
    const result = vm.evalCode(code + "\n;JSON.stringify(exports." + fn + "(..." + JSON.stringify(test.args) + ")).slice(0,16384)", "candidate.js",{type:"global"});
    if (result.error) { result.error.dispose(); return "error"; }
    try { return equal(JSON.parse(vm.getString(result.value)),test.expected) ? "pass" : "fail"; }
    finally { result.value.dispose(); }
  } catch { return "error"; }
  finally { vm.dispose(); rt.dispose(); }
}
self.onmessage = async ({data:p}) => {
  const engine = await newQuickJSWASMModuleFromVariant(variant);
  const candidate = p.source.replace(p.before,()=>p.after);
  const tests = [...regressionCases[p.area]];
  if (p.example) tests.push({name:"Proposed behavior",...p.example});
  self.postMessage(tests.map(test=>({name:test.name,baseline:check(engine,p.source,runnable[p.area],test),
    candidate:check(engine,candidate,runnable[p.area],test)})));
};
