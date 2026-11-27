// Only reviewed source paths enter the assistant bundle. The build reads Git
// objects from the release commit, never local provider files or working data.
export const areas = {
  "Application architecture and request routing": "apps/admin/hosted/worker.mjs",
  "Wing reporting and historical comparisons": "apps/admin/hosted/wing-charts.mjs",
  "Google adapter entry points": "apps/google-adapter/src/index.ts",
  "Excusal queue": "apps/admin/src/attendance-events.mjs",
  "Birthday agenda": "apps/admin/src/birthday-agenda.mjs",
  "Cadet sorting": "packages/domain/src/cadet-display-order.ts",
  "Attendance corrections": "apps/worker/src/corrections.ts",
  "Sunday closeout": "packages/domain/src/closeout.ts",
  "Excusal permissions": "apps/worker/src/excusal-scope.ts",
  "Semester transitions": "packages/domain/src/transitions.ts",
  "Panel caching": "apps/worker/src/panel-cache.ts",
  "Sheet protections": "apps/google-adapter/src/frontend-protections.ts",
  "Sheet edits": "apps/google-adapter/src/frontend-input.ts",
};
export const runnable = {
  "Sunday closeout": "closeoutCode",
  "Cadet sorting": "compareCadetsForDisplay",
  "Excusal queue": "currentExcusalRequests",
  "Birthday agenda": "birthdayPage",
};
export function maintenanceRequest(area, question, catalog) {
  if (!Object.hasOwn(areas, area) || !catalog?.commit || !catalog.files[area]) throw Error("Unknown source area");
  const path = areas[area], source = catalog.files[area];
  return {
    instructions: "You maintain SHAMROCK. Use only the supplied release source. Explain the change and cite its path and function. If this file cannot support the requested change, explain what else is needed and leave before/after empty. Otherwise propose ONE literal substitution: before must be unique verbatim source, after is its replacement. No markdown fences inside either field. Never claim tests ran. For a runnable function provide one meaningful fictional behavioral case, encode each positional argument separately as a JSON string in args, and encode the expected return value in expected. For other files use an empty args array and empty expected string and describe the required integration test.",
    input: JSON.stringify({revision:catalog.commit,path,source,entry:runnable[area] || null,question}),
    text: {format:{type:"json_schema",name:"maintenance",strict:true,schema:{
      type:"object",additionalProperties:false,required:["summary","before","after","args","expected"],
      properties:{
        summary:{type:"string"}, before:{type:"string"}, after:{type:"string"},
        args:{type:"array",items:{type:"string"},description:"One JSON-serialized value per positional argument. For fn(snapshot), supply one string containing the fictional snapshot object."},
        expected:{type:"string",description:"JSON-serialized expected return value. For an empty queue use the literal string []."},
      },
    }}},
  };
}
export function proposalResult(area, text, catalog) {
  const {summary,before,after,args,expected} = JSON.parse(text);
  if (typeof summary !== "string" || !summary.trim()) throw Error("Missing proposal");
  const source = catalog.files[area], path = areas[area];
  const reference = path + " @ " + catalog.commit.slice(0,12);
  if (!before || before === after || source.split(before).length !== 2)
    return {content:summary+"\n\n"+reference+"\nNo applicable change produced."};
  let example = null;
  if (runnable[area] && Array.isArray(args) && args.length && expected) {
    try {
      example = {args:args.map(arg=>JSON.parse(arg)), expected:JSON.parse(expected)};
    } catch { /* The fixed regression cases can still run. */ }
  }
  return {content:summary, proposal:{area,path,commit:catalog.commit,source,before,after,example}};
}
