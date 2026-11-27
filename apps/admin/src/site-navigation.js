import {CalendarDays, ChevronsUp, ClipboardList, FileCheck2, Home, Layers, Settings, UserRound, Users} from "lucide-react";

const wingPages = [
  ["Overview", Home], ["Events", CalendarDays], ["Attendance", ClipboardList],
  ["Excusals", FileCheck2], ["Cadets", Users], ["Leadership", ChevronsUp],
  ["Semester planning", Layers], ["System", Settings],
];
export function leadershipPages(full, preview) {
  if (!full) return wingPages.filter(([page]) => page === "Attendance" || page === "Excusals");
  return preview ? wingPages.filter(([page]) => page !== "Semester planning" && page !== "System") : wingPages;
}

export function personalPages(state) {
  if (!state || state.registration) return [];
  return [
    ...(state.flightCommander ? [["My Flight", Users]] : []),
    ["My excusals", ClipboardList], ["My attendance", ClipboardList], ["Submit attendance", ClipboardList],
    ...(state.squadron || state.flightCommander ? [["Excusals", FileCheck2]] : []),
    ["Cadets", Users], ["Leadership", ChevronsUp], ["Overview", Home],
    ...(state.squadron ? [["Attendance reviews", FileCheck2]] : []),
    ["My profile", UserRound],
  ];
}
