import React, { useState } from "react";

import { drivePhoto } from "../drive-photo.mjs";

function directoryPhotoSource(value, size, personId) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const link = { href: url.href };
  if (url.hostname.endsWith(".googleusercontent.com")) return { ...link, src: url.href };
  const drive = drivePhoto(value);
  if (!drive) return link;
  const parameters = new URLSearchParams({ id: drive.file, sz: "w" + size });
  const preview = new URL("/file/d/" + drive.file + "/preview", url.origin);
  if (drive.resourceKey) {
    parameters.set("resourcekey", drive.resourceKey);
    preview.searchParams.set("resourcekey", drive.resourceKey);
  }
  const direct = "https://drive.google.com/thumbnail?" + parameters;
  const query = new URLSearchParams({file:drive.file});
  if (personId) query.set("person", personId);
  return { ...link, preview:preview.href, src:personId === undefined ? direct : "/api/directory/photo?" + query, direct };
}

export function useDirectoryPhoto(value, size, personId) {
  const source = directoryPhotoSource(value, size, personId);
  const [directOnly, setDirectOnly] = useState("");
  const [failed, setFailed] = useState("");
  const src = source?.src === directOnly ? source?.direct : source?.src;
  const onError = () => {
    if (source.direct && src !== source.direct) setDirectOnly(source.src);
    else setFailed(src);
  };
  return { source, src:src === failed ? null : src, onError };
}

export function DirectoryPhoto({ value, person, avatar = false, personId = person?.personId }) {
  const {source, src, onError} = useDirectoryPhoto(value, avatar ? 96 : 320, personId);
  const [opened, setOpened] = useState("");
  const name = [person?.firstName, person?.lastName].filter(Boolean).join(" ");
  const image = src
    ? <img src={src} loading="lazy" decoding="async" referrerPolicy="no-referrer"
        alt={avatar ? "" : "Directory photo" + (name ? " of " + name : "")}
        onError={onError} />
    : null;
  if (avatar) return <span className="initials directory-avatar" aria-hidden="true">
    {image || <>{person?.firstName?.[0]}{person?.lastName?.[0]}</>}
  </span>;
  if (!source) return null;
  return <div className="directory-photo">
    {image}
    {source.preview && !src && <button type="button" onClick={() => setOpened(opened === source.preview ? "" : source.preview)}
      aria-expanded={opened === source.preview}>{opened === source.preview ? "Close preview" : "Preview photo"}</button>}
    <a href={source.href} target="_blank" rel="noreferrer">Open photo</a>
    {source.preview && opened === source.preview && <iframe title="Directory photo preview" src={source.preview} referrerPolicy="no-referrer" />}
  </div>;
}
