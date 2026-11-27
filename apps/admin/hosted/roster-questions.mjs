const months=Array.from({length:12},(_,i)=>new Intl.DateTimeFormat("en",{month:"long",timeZone:"UTC"}).format(Date.UTC(2024,i,1)));
const normalize=value=>String(value).trim().toLowerCase();
function monthIn(text) {
  const words=text.toLowerCase().match(/[a-z]+/g) || [];
  return months.filter(name=>words.includes(normalize(name)) || words.includes(normalize(name).slice(0,3)));
}
export function rosterQuestion(messages) {
  if(!Array.isArray(messages) || messages.at(-1)?.role!=="user")return null;
  const text=String(messages.at(-1).content).trim();
  const previous=messages.slice(0,-1).filter(m=>m.role==="user").at(-1);
  const birthday=/\bbirthdays?\b/i;
  if(/^(?:fix|change|implement|build|redesign|remove|edit|add|why|how (?:does|do))\b/i.test(text))return null;
  if(birthday.test(text) || (/^(?:what about |how about |and |in )?[a-z]+[?.! ]*$/i.test(text) && birthday.test(previous?.content || ""))){
    const matches=monthIn(text);
    if(matches.length!==1)return {content:"Which month should I check for birthdays?"};
    return {content:matches[0]+" birthdays",rosterLookup:{kind:"birthday",value:matches[0]}};
  }
  const flight=text.match(/^(?:who(?:’s|'s| is| are)|list|show)(?: the| me)?(?: cadets| members)? (?:in |on )?(alpha|bravo|charlie|delta|echo|foxtrot) flight[?.! ]*$/i);
  if(flight)return {content:flight[1][0].toUpperCase()+flight[1].slice(1).toLowerCase()+" Flight roster",rosterLookup:{kind:"flight",value:normalize(flight[1])}};
  return null;
}
export function rosterRows(kind,value,tables){
  if(kind==="birthday"){
    const index=months.indexOf(value);
    if(index===-1)return null;
    const prefix=String(index+1).padStart(2,"0")+"-";
    return JSON.parse(tables.birthdays).filter(r=>typeof r[2]==="string" && r[2].startsWith(prefix))
      .sort((a,b)=>a[2].localeCompare(b[2])||a[1].localeCompare(b[1])||a[0].localeCompare(b[0]))
      .map(([first,last,day])=>value+" "+Number(day.slice(3))+" · "+first+" "+last);
  }
  if(kind!=="flight" || !/^(alpha|bravo|charlie|delta|echo|foxtrot)$/.test(value))return null;
  const ids=new Set(JSON.parse(tables.flights).filter(r=>normalize(r[1]).replace(/ flight$/,"")===value).map(r=>r[0]));
  return JSON.parse(tables.people).filter(r=>ids.has(r[2]) && !["Inactive","Commissioned","Dropped"].includes(r[7]))
    .sort((a,b)=>a[3].localeCompare(b[3])||a[4].localeCompare(b[4])).map(r=>r[4]+" "+r[3]);
}
