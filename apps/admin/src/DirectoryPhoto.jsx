import React, { useState } from "react";

export function directoryPhotoSource(value, size) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const link = { href: url.href };
  if (url.hostname.endsWith(".googleusercontent.com")) return { ...link, src: url.href };
  if (url.origin !== "https://drive.google.com") return link;
  const id = url.pathname.match(/^\/file\/d\/([\w-]+)(?:\/|$)/)?.[1]
    || url.searchParams.get("id");
  if (!id || !/^[\w-]+$/.test(id)) return link;
  const parameters = new URLSearchParams({ id, sz: "w" + size });
  const preview = new URL("/file/d/" + id + "/preview", url.origin);
  for (const [key, entry] of url.searchParams) {
    if (key.toLowerCase() === "resourcekey") {
      parameters.set("resourcekey", entry);
      preview.searchParams.set("resourcekey", entry);
    }
  }
  return { ...link, preview:preview.href, src: "https://drive.google.com/thumbnail?" + parameters };
}

export function DirectoryPhoto({ value, person, avatar = false }) {
  const source = directoryPhotoSource(value, avatar ? 96 : 320);
  const [failed, setFailed] = useState("");
  const [opened, setOpened] = useState("");
  const name = [person?.firstName, person?.lastName].filter(Boolean).join(" ");
  const image = source?.src && failed !== source.src
    ? <img src={source.src} loading="lazy" decoding="async" referrerPolicy="no-referrer"
        alt={avatar ? "" : "Directory photo" + (name ? " of " + name : "")}
        onError={() => setFailed(source.src)} />
    : null;
  if (avatar) return <span className="initials directory-avatar" aria-hidden="true">
    {image || <>{person?.firstName?.[0]}{person?.lastName?.[0]}</>}
  </span>;
  if (!source) return null;
  return <div className="directory-photo">
    {image}
    {source.preview && source.src === failed && <button type="button" onClick={() => setOpened(opened === source.preview ? "" : source.preview)}
      aria-expanded={opened === source.preview}>{opened === source.preview ? "Close preview" : "Preview photo"}</button>}
    <a href={source.href} target="_blank" rel="noreferrer">Open photo</a>
    {source.preview && opened === source.preview && <iframe title="Directory photo preview" src={source.preview} referrerPolicy="no-referrer" />}
  </div>;
}
