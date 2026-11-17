import { hydrateReporting } from "./reporting";
import { loadSnapshot } from "../snapshot-client";
let csrf;
let retainedCapture;
export async function api(path, body) {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : { "content-type": "application/json", "x-shamrock-csrf": csrf || "" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      retainedCapture = undefined;
    const error = new Error(
      data.error?.message || "Unable to complete this request.",
    );
    error.code = data.error?.code;
    error.status = response.status;
    throw error;
  }
  if (path === "/state") {
    if (data.transport === "paged-v1") {
      const key = JSON.stringify([data.captureKey, data.manifest]);
      if (retainedCapture?.key === key)
        data.snapshot = retainedCapture.snapshot;
      else {
        data.snapshot = await loadSnapshot(data, api);
        retainedCapture = { key, snapshot: data.snapshot };
      }
    }
    return hydrateReporting(data);
  }
  return data;
}
export async function startSession() {
  retainedCapture = undefined;
  csrf = (await api("/session", {})).csrf;
}
export const name = (p) =>
  p ? [p.firstName, p.lastName].filter(Boolean).join(" ") : "Unknown cadet";
export const label = (key) =>
  ({
    asYear: "AS year",
    flightPathStatus: "Flight Path",
    cipBroadArea: "CIP broad area",
    cipCode: "CIP code",
    afsc: "AFSC",
    dateOfBirth: "Date of birth",
    photoLink: "Photo link",
    columnLabel: "Attendance header",
    startAt: "Starts",
    endAt: "Ends",
    expectedGroup: "Expected attendees",
    trainingWeek: "Training week",
    displayOrder: "Display order",
    flightId: "Flight",
    eligiblePersonIds: "Expected cadets",
    flightIds: "Flights",
    termId: "Semester",
    eventType: "Type",
    reportsTo: "Reports to",
    cellPhone: "Cell phone",
    officePhone: "Office phone",
    officeLocation: "Office location",
  })[key] ||
  key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
export const eventTypes = {
  mando: "Mando PT",
  secondary: "Secondary PT",
  llab: "LLAB",
  other: "Other",
};
export const years = [
  "AS100",
  "AS150",
  "AS200",
  "AS250",
  "AS300",
  "AS400",
  "AS500",
  "AS700",
  "AS800",
  "AS900",
  "AF Civ",
];
export const statuses = [
  "Participating 1/4",
  "Enrolled 2/4",
  "Active 3/4",
  "Ready 4/4",
  "Inactive",
  "Commissioned",
  "Dropped",
];
export const profileFields = [
  "lastName",
  "firstName",
  "asYear",
  "rank",
  "role",
  "university",
  "email",
  "phone",
  "dorm",
  "cipBroadArea",
  "cipCode",
  "afsc",
  "homeTown",
  "homeState",
  "classYear",
  "dateOfBirth",
  "flightPathStatus",
  "photoLink",
];
export const displayDate = (value) =>
  value
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Indiana/Indianapolis",
      }).format(new Date(value))
    : "Not scheduled";

export async function logout() {
  const response = await fetch("/auth/logout", {
    method: "POST",
    headers: { "x-shamrock-csrf": csrf || "" },
  });
  if (!response.ok)
    throw new Error("Sign-out did not complete. Please reload.");
  retainedCapture = undefined;
  location.assign("/");
}
