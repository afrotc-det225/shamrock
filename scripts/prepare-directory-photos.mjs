// Input is the custodian-reviewed association between each person and their photo.
// The output contains private thumbnail bytes for Wrangler's KV bulk put command.
import {execFileSync} from "node:child_process";
import {readFile, writeFile} from "node:fs/promises";
import {drivePhoto, portraitKey, imageType} from "../apps/admin/drive-photo.mjs";

const [account, rosterPath, outputPath] = process.argv.slice(2);
if (!account || !rosterPath || !outputPath) throw Error("Supply the Google account, reviewed roster JSON, and a new private output path.");
const roster = JSON.parse(await readFile(rosterPath, "utf8"));
if (!Array.isArray(roster) || roster.length > 1000 || roster.some(p => !p.personId || typeof p.personId !== "string" || typeof p.photoLink !== "string"))
  throw Error("Invalid reviewed Directory roster.");
const token = execFileSync("gcloud", ["auth","print-access-token","--account="+account], {encoding:"utf8"}).trim();
const authorization = "Bearer " + token;

async function thumbnail({file, resourceKey}) {
  const response = await fetch("https://www.googleapis.com/drive/v3/files/"+file+"?supportsAllDrives=true&fields=mimeType,thumbnailLink,trashed,capabilities(canDownload)", {
    headers:{authorization,...(resourceKey ? {"X-Goog-Drive-Resource-Keys":file+"/"+resourceKey} : {})}, redirect:"error",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw Error("Drive file check failed (HTTP "+response.status+"). No upload prepared.");
  const meta = await response.json();
  if (meta.trashed || !meta.capabilities?.canDownload || !meta.mimeType?.startsWith("image/") || !meta.thumbnailLink) return null;
  const url = new URL(meta.thumbnailLink);
  if (url.protocol !== "https:" || url.port || url.username || url.password || !url.hostname.endsWith(".googleusercontent.com"))
    throw Error("Unexpected Drive thumbnail origin.");
  const image = await fetch(url,{headers:{authorization},redirect:"error"});
  if (!image.ok) throw Error("Drive thumbnail failed (HTTP "+image.status+"). No upload prepared.");
  const bytes = new Uint8Array(await image.arrayBuffer());
  if (bytes.length > 512*1024 || !imageType(bytes)) throw Error("Unsupported or oversized Drive thumbnail.");
  return Buffer.from(bytes).toString("base64");
}

const entries = [], seen = new Set();
let unavailable = 0, skipped = 0;
for (const p of roster) {
  const ref = drivePhoto(p.photoLink);
  if (!ref) { skipped++; continue; }
  const key = await portraitKey(p.personId,ref.file);
  if (seen.has(key)) throw Error("Duplicate reviewed Directory photo.");
  seen.add(key);
  const image = await thumbnail(ref);
  if (!image) unavailable++;
  // An empty value retires a previously published photo that is now unavailable.
  entries.push({key,value:image || "",base64:true});
}
await writeFile(outputPath, JSON.stringify(entries), {flag:"wx",mode:0o600});
console.log("Prepared "+(entries.length-unavailable)+" portraits, "+unavailable+" unavailable, "+skipped+" other links or blanks.");
