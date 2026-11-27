// Directory position titles that a Flight commander may assign without changing command authority.
export function flightRoleOptions(flight: string): string[] {
  return [
    "Accountability",
    "MWR",
    "PA/PO",
    "Supply",
    "Uniform",
    "Uniform & MWR",
  ].map((position) => `${flight} Flight ${position} Officer`);
}
