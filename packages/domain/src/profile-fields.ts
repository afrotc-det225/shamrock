import {profileChoices} from "./profile-choices.js";

const fieldNames: Record<string,string> = {university:"University", dorm:"Residence", homeState:"Home state", cipBroadArea:"CIP broad area", afsc:"AFSC"};
export function profileFieldIssue(key: string, raw: unknown, broadArea?: unknown): string {
  if (raw == null || raw === "") return "";
  if (typeof raw !== "string") return "Enter a text value.";
  const options = Object.hasOwn(profileChoices,key) && profileChoices[key];
  if (options && !options.includes(raw)) return "Choose " + fieldNames[key] + " from the list.";
  if (["phone","cellPhone","officePhone"].includes(key)) {
    const number = raw.replace(/\s*(?:ext\.?|x)\s*\d{1,6}$/i, "");
    const digits = number.replace(/\D/g,"");
    if (!/^\+?[\d ().-]+$/.test(number) || !(number.startsWith("+") ? /^[1-9]\d{6,14}$/.test(digits) : /^(?:1)?\d{10}$/.test(digits)))
      return "Enter a 10-digit phone number or an international number starting with +.";
  }
  if (key === "email" && !/^[^\s@,;<>]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(raw))
    return "Enter a complete email address.";
  if (key === "cipCode" && !/^\d{2}\.\d{4}$/.test(raw)) return "Enter the six-digit CIP code as 00.0000.";
  if (key === "cipCode" && typeof broadArea === "string" && /^\d{2} - /.test(broadArea) && !raw.startsWith(broadArea.slice(0,2) + "."))
    return "The first two digits of the CIP code must match its broad area.";
  if (key === "classYear" && !/^\d{4}$/.test(raw)) return "Enter a four-digit graduation year.";
  if (key === "dateOfBirth" && (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || raw > new Date().toISOString().slice(0,10)))
    return "Enter a date of birth on or before today.";
  if (key === "photoLink") {
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" && !url.username && !url.password) return "";
    } catch {}
    return "Enter an HTTPS photo link.";
  }
  return "";
}
