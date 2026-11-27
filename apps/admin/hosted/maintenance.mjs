// Only reviewed source paths enter the assistant bundle. The build reads Git
// objects from the release commit, never local provider files or working data.
export const areas = {
  "Application architecture and request routing": "apps/admin/hosted/worker.mjs",
  "Wing reporting and historical comparisons": "apps/admin/hosted/wing-charts.mjs",
  "Google adapter entry points": "apps/google-adapter/src/index.ts",
  "Excusal queue": "apps/admin/src/attendance-events.mjs",
  "Birthday agenda": "apps/admin/src/birthday-agenda.mjs",
  "Wing overview": "apps/admin/src/OverviewInsights.jsx",
  "Wing charts": "apps/admin/src/WingCharts.jsx",
  "Cadet profile and submissions": "apps/admin/src/CadetWorkspace.jsx",
  "Cadet profile fields": "apps/admin/src/ProfileField.jsx",
  "Flight home": "apps/admin/src/FlightHome.jsx",
  "Cadet directory and Leadership": "apps/admin/src/People.jsx",
  "Directory roster views": "apps/admin/src/RosterViews.jsx",
  "Attendance matrix": "apps/admin/src/AttendanceMatrix.jsx",
  "Attendance page": "apps/admin/src/AttendancePage.jsx",
  "Excusals page": "apps/admin/src/Excusals.jsx",
  "Semester planner": "apps/admin/src/Semester.jsx",
  "Event management page": "apps/admin/src/Events.jsx",
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
  "Birthday agenda": "birthdayGroups",
};
export function patchSourceArea(question, classifiedArea, files = {}) {
  const identifiers = new Set(question.match(/[A-Za-z0-9_./-]+/g) ?? []);
  const named = Object.entries(areas).filter(([area, path]) =>
    identifiers.has(path) || identifiers.has(path.split("/").pop()) || identifiers.has(runnable[area]));
  if (named.length === 1) return named[0][0];
  // Maintainers often identify a screen by the wording they see on it.
  for (const phrase of question.matchAll(/["“‘']([^"”’'\n]{4,120})["”’']/g)) {
    const matches=Object.keys(areas).filter(area=>files[area]?.includes(phrase[1]));
    if(matches.length===1) return matches[0];
  }
  return classifiedArea;
}

export function maintenanceRequest(area, question, catalog) {
  if (!Object.hasOwn(areas, area) || !catalog?.commit || !catalog.files[area]) throw Error("Unknown source area");
  const path = areas[area], source = catalog.files[area];
  const terms=new Set(question.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const sourceWindow=(code,length)=>{
    if(code.length<=length)return code;
    const lines=code.split("\n");
    let at=0,best=0;
    lines.forEach((line,i)=>{
      const words=new Set(line.toLowerCase().match(/[a-z]{4,}/g) ?? []);
      const score=[...terms].filter(w=>words.has(w)).length;
      if(score>best){best=score;at=i;}
    });
    return lines.slice(Math.max(0,at-15)).join("\n").slice(0,length);
  };
  const related=Object.entries(areas).filter(([name])=>name!==area && catalog.files[name])
    .map(([name,file])=>({name,file,score:Number(source.includes(file.split("/").pop().replace(/\.[^.]+$/,"")))*4+
      (name.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(w=>terms.has(w)).length}))
    .filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,2)
    .map(({name,file})=>({area:name,path:file,source:sourceWindow(catalog.files[name],2800)}));
  return {
    instructions: "Write the summary for a detachment maintainer. In one or two plain-language sentences describe what they will see or do differently and where. The app shows testing and publishing status separately. Keep filenames, commands, branches, model names and developer instructions out of the summary. Describe the proposed change accurately in future tense. Use only the supplied release source. If this file cannot support the requested change, explain what else is needed and leave before/after empty. Propose one primary literal substitution and any necessary companion edits in the provided related files: before must be unique verbatim source, after is its replacement. No markdown fences inside either field. Never claim tests ran. For a runnable function provide one meaningful fictional behavioral case, encode each positional argument separately as a JSON string in args, and encode the expected return value in expected. For other files use an empty args array and empty expected string and keep the summary focused on the visible result.",
    input: JSON.stringify({revision:catalog.commit,path,source:sourceWindow(source,14000),related,entry:runnable[area] || null,question}),
    text: {format:{type:"json_schema",name:"maintenance",strict:true,schema:{
      type:"object",additionalProperties:false,required:["summary","before","after","args","expected","companions"],
      properties:{
        companions:{type:"array",maxItems:2,items:{type:"object",additionalProperties:false,required:["area","before","after"],
          properties:{area:{type:"string",enum:related.length ? related.map(r=>r.area) : ["none"]},before:{type:"string"},after:{type:"string"}}}},
        summary:{type:"string"}, before:{type:"string"}, after:{type:"string"},
        args:{type:"array",items:{type:"string"},description:"One JSON-serialized value per positional argument. For fn(snapshot), supply one string containing the fictional snapshot object."},
        expected:{type:"string",description:"JSON-serialized expected return value. For an empty queue use the literal string []."},
      },
    }}},
  };
}
export function proposalResult(area, text, catalog) {
  const {summary,before,after,args,expected,companions=[]} = JSON.parse(text);
  if (typeof summary !== "string" || !summary.trim()) throw Error("Missing proposal");
  const source = catalog.files[area], path = areas[area];
  const reference = path + " @ " + catalog.commit.slice(0,12);
  if (!before || before === after || source.split(before).length !== 2)
    return {content:summary+"\n\n"+reference+"\nNo applicable change produced."};
  const edits=validateEdits([{area,path,before,after},...companions.map(c=>({...c,path:areas[c.area]}))],catalog.files);
  let example = null;
  if (runnable[area] && Array.isArray(args) && args.length && expected) {
    try {
      example = {args:args.map(arg=>JSON.parse(arg)), expected:JSON.parse(expected)};
    } catch { /* The fixed regression cases can still run. */ }
  }
  return {content:summary, proposal:{area,path,commit:catalog.commit,source,before,after,example,edits}};
}

export function validateEdits(edits,files){
  if(!Array.isArray(edits) || !edits.length || edits.length>3)throw Error("Invalid patch size");
  const paths=new Set();
  return edits.map(({area,path,before,after})=>{
    if(!Object.hasOwn(areas,area) || path!==areas[area] || paths.has(path) || typeof before!=="string" ||
       !before || typeof after!=="string" || before===after || files[area]?.split(before).length!==2)throw Error("Patch does not match release");
    paths.add(path);return {area,path,before,after};
  });
}
