// Student mailbox domains used by the host and four Detachment 225 crosstown schools.
export const CADET_SCHOOLS: Record<string, string> = {
  "nd.edu": "Notre Dame",
  "saintmarys.edu": "St. Mary's",
  "hcc-nd.edu": "Holy Cross",
  "my.trine.edu": "Trine",
  "valpo.edu": "Valparaiso",
};
export function schoolForEmail(email: string) {
  const parts = email.toLowerCase().split("@");
  return parts.length === 2 &&
    parts[0] &&
    Object.hasOwn(CADET_SCHOOLS, parts[1])
    ? CADET_SCHOOLS[parts[1]]
    : null;
}
