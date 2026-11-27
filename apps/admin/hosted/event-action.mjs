import {browseState} from "./browse.mjs";
import {eventEditorData, existingEventPayload} from "../event-editor.mjs";

const normalize = text => text.toLowerCase().replace(/[‐‑–—]/g,"-").replace(/\s+/g," ").trim();

export async function eventCancellationReply(message,backend,service,read=browseState) {
  if (message?.role !== "user" || typeof message.content !== "string") return null;
  const match = normalize(message.content).match(/^(?:(?:can|could|would) you )?(?:please )?(?:cancel|remove) (?:only )?(?:the )?(?:(?:current semester[’']s|current term[’']s) )?(.+?)[.?!]*$/);
  if (!match) return null;
  // Leave website maintenance requests such as "remove a button" with the code assistant.
  if (/\bremove\b/.test(match[0]) && !/\b(?:event|tw[- ]?\d+|llab|mando|secondary)\b/.test(match[1])) return null;
  const target = match[1].replace(/^(?:event )/,"").replace(/(?: event)?(?: in (?:real-data )?staging)?$/,"").trim();
  const authority = await backend.panelAuthority();
  const view = await read(backend,authority,"event-list");
  const term = JSON.parse(view.tables.terms).filter(row=>row[3]);
  if (term.length !== 1) return {content:"I couldn’t identify the current semester. No event was changed."};
  const matches = JSON.parse(view.tables.events).filter(row=>row[1]===term[0][0] && normalize(row[4])===target);
  if (matches.length!==1) return {content:matches.length ? "More than one event matches in the current semester. Review the Events page to choose the correct one." : "I couldn’t match that request to one current-semester event. Use its exact name, for example “Cancel TW-12 LLAB.” No event was changed."};
  const source = eventEditorData(await read(backend,authority,"event-editor",matches[0][0]));
  const event = source.events.find(e=>e.eventId===matches[0][0] && e.termId===term[0][0] && normalize(e.label)===target);
  if (!event || !["active","cancelled"].includes(event.status)) return {content:"That event is no longer active. No change was prepared."};
  if (event.status==="cancelled") return {content:event.label+" is already cancelled for "+term[0][1]+"."};
  const proposal = await service.propose("event.upsert",{...existingEventPayload(source,event), status:"cancelled"});
  return {content:"Cancel "+event.label+" for "+term[0][1]+"? This keeps the existing attendance records.",eventAction:{id:proposal.id,eventId:event.eventId,label:event.label}};
}
