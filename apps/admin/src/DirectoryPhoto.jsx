import React, { useEffect, useRef, useState } from "react";

import { createPortal } from "react-dom";
import { X } from "lucide-react";
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

function PhotoPreview({source, src, onError, name, onClose}) {
  const ref=useRef(null);
  useEffect(()=>{
    const dialog=ref.current;
    dialog.showModal();
    return ()=>dialog.close();
  },[]);
  return createPortal(<dialog ref={ref} className="portrait-preview" aria-label={"Photo of "+name}
    onCancel={e=>{e.preventDefault();onClose();}}>
    <header><strong>{name}</strong><button type="button" aria-label="Close preview" onClick={onClose}><X size={18}/></button></header>
    {src ? <img src={src} alt={name} referrerPolicy="no-referrer" onError={onError}/> :
      source.preview ? <iframe title="Directory photo preview" src={source.preview} referrerPolicy="no-referrer"/> :
      <p>Preview unavailable.</p>}
    <footer><a href={source.href} target="_blank" rel="noreferrer">Open original photo</a></footer>
  </dialog>,document.body);
}

export function DirectoryPhoto({ value, person, avatar = false, portrait = false, personId = person?.personId }) {
  const {source,src,onError}=useDirectoryPhoto(value, avatar ? 96 : 320, personId);
  const [opened,setOpened]=useState(null);
  const name=[person?.firstName, person?.lastName].filter(Boolean).join(" ") || "Directory portrait";
  const initials=[person?.firstName,person?.lastName].map(n=>n?.trim()[0]).join("") || "–";
  const content=src ? <img src={src} loading="lazy" decoding="async" referrerPolicy="no-referrer" alt="" onError={onError}/> : <span aria-label="Profile initials">{initials}</span>;
  const appearance=portrait ? "profile-portrait" : avatar ? "initials directory-avatar" : "directory-photo";
  if(!source)return avatar || portrait ? <span className={appearance}>{content}</span> : null;
  return <>
    <button type="button" className={appearance+" photo-trigger"} aria-label={"Preview photo of "+name} aria-haspopup="dialog" onClick={()=>setOpened(source.href)}>{content}</button>
    {opened===source.href && <PhotoPreview source={source} src={src} name={name} onError={onError} onClose={()=>setOpened(null)}/>}
  </>;
}
