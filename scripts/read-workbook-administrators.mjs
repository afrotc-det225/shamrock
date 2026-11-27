// Pipe stdout to the private staging store. Do not commit or log the output.
import assert from "node:assert/strict";
const {SHAMROCK_BACKEND_FILE_ID:id, GOOGLE_ACCESS_TOKEN:token}=process.env;
assert.ok(id && token,"Provide the backend workbook ID and a Drive read token.");
const admins=[];
const seen=new Set();
let page;
do{
  const url=new URL("https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(id)+"/permissions");
  url.search=new URLSearchParams({supportsAllDrives:"true",pageSize:"100",fields:"nextPageToken,permissions(type,role,deleted,emailAddress,displayName)",...(page?{pageToken:page}:{})});
  const response=await fetch(url,{headers:{authorization:"Bearer "+token}});
  if(!response.ok)throw Error("Drive access lookup failed ("+response.status+").");
  const data=await response.json();
  assert.ok(Array.isArray(data.permissions));
  for(const p of data.permissions.filter(p=>!p.deleted && ["owner","writer"].includes(p.role))){
    assert.ok(["user","group"].includes(p.type) && p.emailAddress,"Incomplete administrator list");
    admins.push({label:p.displayName || p.emailAddress,account:p.emailAddress,role:p.role==="owner"?"Owner":"Editor"});
  }
  page=data.nextPageToken;
  if(page){assert.ok(!seen.has(page));seen.add(page);}
}while(page);
assert.ok(admins.length);
console.log(JSON.stringify({checkedAt:new Date().toISOString(),admins:admins.sort((a,b)=>a.role.localeCompare(b.role)||a.label.localeCompare(b.label))}));
