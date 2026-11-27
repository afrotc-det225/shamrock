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
  } else {
    if (!personId || personId.length > 200 || user.principal_id.startsWith("school.")) throw forbidden();
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
