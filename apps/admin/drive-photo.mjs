// Only a Drive file reference can identify a published Directory thumbnail.
export function drivePhoto(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== "https://drive.google.com" || url.username || url.password) return null;
  const file = url.pathname.match(/^\/file\/d\/([\w-]+)(?:\/|$)/)?.[1]
    || (["/open", "/uc", "/thumbnail"].includes(url.pathname) && url.searchParams.get("id"));
  if (!file || !/^[\w-]{1,200}$/.test(file)) return null;
  const resourceKey = [...url.searchParams].find(([k]) => k.toLowerCase() === "resourcekey")?.[1] || "";
  if (resourceKey && !/^[\w-]{1,256}$/.test(resourceKey)) return null;
  return { file, resourceKey };
}

export async function portraitKey(personId, file) {
  const bytes = new TextEncoder().encode(JSON.stringify([personId, file]));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "directory-photos/v1/" + Array.from(hash, n => n.toString(16).padStart(2, "0")).join("");
}

export function imageType(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if ([137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n)) return "image/png";
  if (String.fromCharCode(...bytes.slice(0,4)) === "RIFF" && String.fromCharCode(...bytes.slice(8,12)) === "WEBP") return "image/webp";
  return null;
}
