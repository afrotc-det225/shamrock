// Only these aggregate fields may leave the panel. Source rows can contain private contact data.
export function reportSources(question) {
  const sources=[];
  if (/\b(?:roster|directory|campus|campuses|universit\w*|colleges?|schools?|crosstowns?|valpo|valparaiso|trine)\b/i.test(question)) sources.push("cadets");
  if (/\b(?:excusals?|requests?|pending)\b/i.test(question)) sources.push("overview");
  if (/\b(?:leadership|contacts?|leaders?)\b/i.test(question)) sources.push("leadership");
  if (/\b(?:schedule|events?|cancelled|canceled)\b/i.test(question)) sources.push("event-list");
  return sources;
}
export function reportTotals(profile,tables) {
  if(profile==="overview")return {activeEvents:Number(tables.activeEvents),pendingExcusalsForActiveEvents:Number(tables.pending)};
  if(profile==="cadets"){
    const campusCounts={};
    const names = {"Notre Dame":["notre dame","university of notre dame","nd"],"St. Mary's":["st marys","st marys college","saint marys","saint marys college","smc"],"Holy Cross":["holy cross","holy cross college","hcc"],Trine:["trine","trine university"],Valparaiso:["valparaiso","valparaiso university","valpo"]};
    for(const row of JSON.parse(tables.people)){
      if(["Inactive","Commissioned","Dropped"].includes(row[7]))continue;
      const campus=String(row[11]).toLowerCase().replace(/[.’']/g,"").trim();
      const key=Object.keys(names).find(name=>names[name].includes(campus)) ?? "Other or unspecified";
      campusCounts[key]=(campusCounts[key]??0)+1;
    }
    return {activeCadetsByCampus:campusCounts};
  }
  if(profile==="leadership"){
    const rows=JSON.parse(tables.contacts).filter(r=>r[9]===1 || r[9]===true);
    return {activeLeadershipContacts:rows.length,withOfficePhone:rows.filter(r=>r[11]).length,withOfficeLocation:rows.filter(r=>r[8]).length};
  }
  const counts={};
  const currentTerm=JSON.parse(tables.terms).find(r=>r[3])?.[0];
  for(const [,term,type,,,status] of JSON.parse(tables.events)){
    if(term!==currentTerm)continue;
    const key=(["llab","mando","secondary"].includes(type)?type:"other")+" / "+(["active","inactive","archived","cancelled"].includes(status)?status:"other");
    counts[key]=(counts[key]??0)+1;
  }
  return {currentSemesterEventsByTypeAndStatus:counts};
}
