const zone = "America/Indiana/Indianapolis";
const formatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: zone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export const toEastern = (value) =>
  value ? formatter.format(new Date(value)).replace(" ", "T") : "";
export function fromEastern(value) {
  if (!value) return null;
  const utc = Date.parse(`${value}:00Z`);
  const matches = [4, 5]
    .map((offset) => new Date(utc + offset * 3600000))
    .filter(
      (date) =>
        Number.isFinite(date.getTime()) &&
        toEastern(date.toISOString()) === value,
    );
  if (matches.length !== 1)
    throw new Error(
      "This Eastern time is unavailable or occurs twice during a daylight-saving change. Choose another time.",
    );
  return matches[0].toISOString();
}
