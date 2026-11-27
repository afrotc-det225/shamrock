import {readFileSync,writeFileSync} from "node:fs";
import {areas,validateEdits} from "../apps/admin/hosted/maintenance.mjs";

const job=JSON.parse(readFileSync(0,"utf8"));
const edits=job.edits ?? [job];
if(!Array.isArray(edits) || edits.length>3 || edits.some(e=>!Object.hasOwn(areas,e.area)))throw Error("Invalid source selection");
const files=Object.fromEntries(edits.map(e=>[e.area,readFileSync(areas[e.area],"utf8")]));
for(const {area,path,before,after} of validateEdits(edits,files))
  writeFileSync(path,files[area].replace(before,()=>after));
