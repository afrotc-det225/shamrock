import { drivePhoto, portraitKey, imageType } from "../drive-photo.mjs";
import { PanelError } from "../errors.mjs";

export async function directoryPortrait(env, backend, user, preview, params, ownWorkspace) {
  const missing = () => new PanelError("PHOTO_UNAVAILABLE", "Directory photo unavailable.", 404);
  const forbidden = () => new PanelError("FORBIDDEN", "This photo is outside your access.", 403);
  if (preview && (env.VIEW_AS_ENABLED !== "1" || preview.status !== "ready")) throw forbidden();
  const file = params.get("file");
  if (!file || !/^[\w-]{1,200}$/.test(file)) throw missing();
  let personId = params.get("person");
  let link, directoryReads = 0;
  if (personId === null) {
    const {profile} = await ownWorkspace();
    if (!profile?.personId) throw forbidden();
    personId = profile.personId;
    link = profile.photoLink;
  } else if (params.get("scope") === "member") {
    if (!personId || personId.length > 200) throw missing();
    const viewer = await ownWorkspace();
    if (viewer.registration || !viewer.profile?.personId) throw forbidden();
    const lookup = await env.DB.prepare(`SELECT d.photo_link FROM directory_profiles d
      JOIN memberships m ON m.person_id=d.person_id AND m.unit_id=d.flight_id AND m.active=1
      WHERE d.person_id=? AND d.flight_path_status NOT IN ('Inactive','Dropped','Commissioned')`).bind(personId).all();
    link = lookup.results[0]?.photo_link;
    directoryReads = lookup.meta?.rows_read;
  } else {
    if (!personId || personId.length > 200 || (user.principal_id.startsWith("school.") && !user.wingAccess)) throw forbidden();
    if (!(await backend.panelAuthority()).access?.capabilities?.fullSnapshot) throw forbidden();
    const lookup = await env.DB.prepare("SELECT photo_link FROM directory_profiles WHERE person_id=?").bind(personId).all();
    link = lookup.results[0]?.photo_link;
    directoryReads = lookup.meta?.rows_read;
  }
  if (drivePhoto(link)?.file !== file) throw missing();
  const bytes = await env.HISTORY_FILES.get(await portraitKey(personId, file), "arrayBuffer");
  const type = bytes && imageType(new Uint8Array(bytes));
  if (!type) throw missing();
  return new Response(bytes, {headers:{"Content-Type":type, "Cross-Origin-Resource-Policy":"same-origin",
    "X-Shamrock-D1-Rows-Read":String(directoryReads ?? "unknown")}});
}

// The authorized profile already identifies the owner and file. Include its small
// thumbnail in that response to avoid a second full identity/preview lookup.
export async function profileWithPortrait(env,workspace){
  const profile=workspace.profile, file=drivePhoto(profile?.photoLink)?.file;
  if(!file || !profile?.personId)return workspace;
  let portrait=null;
  try{
    const bytes=await env.HISTORY_FILES?.get(await portraitKey(profile.personId,file),"arrayBuffer");
    const type=bytes && imageType(new Uint8Array(bytes));
    if(type && bytes.byteLength<=128*1024)portrait="data:"+type+";base64,"+Buffer.from(bytes).toString("base64");
  }catch{ /* The existing Google preview remains available. */ }
  return {...workspace,profile:{...profile,portrait}};
}
