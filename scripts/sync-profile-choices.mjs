// Keep the web form and its write validator aligned with the Apps Script Data Legend.
import {readFile, writeFile} from "node:fs/promises";
import {readCanonicalLegend} from "./lib/operational-legend.mjs";
const {values} = readCanonicalLegend(await readFile(new URL("../src/utils/arrays.ts", import.meta.url), "utf8"));
const keys = {university:"university_options", dorm:"dorm_options", homeState:"home_state_options", cipBroadArea:"cip_broad_area_options", afsc:"afsc_options"};
const choices = Object.fromEntries(Object.entries(keys).map(([field, list]) => [field, values[list]]));
const generated = "// Generated from the SHAMROCK Data Legend by scripts/sync-profile-choices.mjs.\nexport const profileChoices: Readonly<Record<string, readonly string[]>> = " + JSON.stringify(choices, null, 2) + ";\n";
const path = new URL("../packages/domain/src/profile-choices.ts", import.meta.url);
if (process.argv.includes("--check")) {
  if (await readFile(path, "utf8") !== generated) throw Error("Run node scripts/sync-profile-choices.mjs after updating the Data Legend.");
} else await writeFile(path, generated);
