/** Display order extracted from the supported Apps Script Directory/Attendance comparators. */
export const AS_YEAR_DISPLAY_ORDER = ['AS900', 'AS800', 'AS700', 'AS400', 'AS300', 'AS500', 'AS250', 'AS200', 'AS150', 'AS100', 'AF Civ'] as const;
export const normalizeDisplayAsYear = (value: string): string => value.trim().toUpperCase().replace(/\s+/g, '');
const yearPosition = new Map<string, number>(AS_YEAR_DISPLAY_ORDER.map((year, i) => [normalizeDisplayAsYear(year), i]));
const text = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' });
const identity = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export function compareAsYearsForDisplay(a: string, b: string): number {
  const left = normalizeDisplayAsYear(a), right = normalizeDisplayAsYear(b);
  const leftPosition = yearPosition.get(left), rightPosition = yearPosition.get(right);
  if (leftPosition !== undefined && rightPosition !== undefined) return leftPosition - rightPosition;
  if (leftPosition !== undefined) return -1;
  if (rightPosition !== undefined) return 1;
  return text(right, left);
}

export interface CadetDisplayIdentity { personId: string; asYear: string; lastName: string; firstName: string }
/** AS500 is a senior GMC category, below AS300; numeric AS sorting is incorrect. */
export function compareCadetsForDisplay(a: CadetDisplayIdentity, b: CadetDisplayIdentity): number {
  return compareAsYearsForDisplay(a.asYear, b.asYear) || text(a.lastName, b.lastName)
    || text(a.firstName, b.firstName) || identity(a.personId, b.personId);
}

// Leadership has a different supported order: cadre, operational role, rank, role/name.
const cadetRanks = ['C/4C', 'C/3C', 'C/2d Lt', 'C/1st Lt', 'C/Capt', 'C/Maj', 'C/Lt Col', 'C/Col'].map(value => value.toLowerCase());
const militaryRanks = ['AB', 'Amn', 'A1C', 'SrA', 'SSgt', 'TSgt', 'MSgt', 'SMSgt', 'CMSgt', '2d Lt', '1st Lt', 'Capt', 'Maj', 'Lt Col', 'Col', 'Brig Gen', 'Maj Gen', 'Lt Gen', 'Gen'].map(value => value.toLowerCase());
const honorifics = ['Mr.', 'Mrs.', 'Ms.', 'Miss', 'Mx.', 'Dr.', 'Prof.', 'Rev.', 'Fr.', 'Sister', 'Brother'].map(value => value.toLowerCase());
const ranks = [...cadetRanks, ...militaryRanks];
const normalizedRank = (value: string) => value.trim().toLowerCase();
const rankGroup = (rank: string) => militaryRanks.includes(rank) || honorifics.includes(rank) ? 0 : cadetRanks.includes(rank) ? 1 : 2;
function rolePriority(raw: string): number {
  const role = raw.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const deputy = role.includes('deputy');
  if (role.includes('wing commander') && !deputy) return 10;
  if (role.includes('deputy wing commander')) return 20;
  if (role.includes('operations group commander') && !deputy) return 30;
  if (role.includes('operations group deputy commander')) return 35;
  if (role.includes('operations group deputy')) return 36;
  if (['blue squadron commander', 'gold squadron commander'].includes(role) && !deputy) return 40;
  if (role.includes('flight commander') && !deputy) return 50;
  if (role.includes('deputy flight commander')) return 60;
  if (role.includes('senior gmc advisor')) return 70;
  if (role.includes('deputy gmc advisor')) return 71;
  return Number.MAX_SAFE_INTEGER;
}
export interface LeadershipDisplayIdentity { contactId: string; rank: string; role: string; lastName: string; firstName: string }
export function compareLeadershipForDisplay(a: LeadershipDisplayIdentity, b: LeadershipDisplayIdentity): number {
  const left = normalizedRank(a.rank), right = normalizedRank(b.rank);
  return rankGroup(left) - rankGroup(right) || rolePriority(a.role) - rolePriority(b.role)
    || ranks.indexOf(right) - ranks.indexOf(left) || text(a.role, b.role)
    || text(a.lastName, b.lastName) || text(a.firstName, b.firstName) || identity(a.contactId, b.contactId);
}
