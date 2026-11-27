// Fill, lettering, and chart ink. Chart marks use a darker shade on white.
const neutral = ["#f0f1f2", "#424a51", "#657480"];
const firstYear = ["#c5d4df", "#172b3b", "#627b92"];
const secondYear = ["#91aabd", "#172b3b", "#56748d"];
const extended = ["#354655", "#ffffff", "#354655"];
const years = {
  AS100: firstYear,
  AS150: firstYear,
  AS200: secondYear,
  AS250: secondYear,
  AS300: ["#506b82", "#ffffff", "#506b82"],
  AS400: ["#344e66", "#ffffff", "#344e66"],
  AS500: ["#8a99a6", "#0d1d2b", "#70808d"],
  AS700: extended,
  AS800: extended,
  AS900: ["#283541", "#ffffff", "#283541"],
};
const blue = {
  alpha: ["#386ba3", "#ffffff", "#386ba3"],
  bravo: ["#579fdb", "#091d2c", "#427eb4"],
  charlie: ["#8cc3fa", "#102a3a", "#5d91bc"],
};
const gold = {
  delta: ["#8a600a", "#ffffff", "#8a600a"],
  echo: ["#b99239", "#231704", "#9b742a"],
  foxtrot: ["#d7bc61", "#302006", "#a5883f"],
};
const flights = { ...blue, ...gold };
const paths = {
  "participating 1/4": ["#d9e8f5", "#1e4b73"],
  "enrolled 2/4": ["#b3d5ed", "#153c5d"],
  "active 3/4": ["#87c9c3", "#123a36"],
  "ready 4/4": ["#257458", "#ffffff"],
  commissioned: ["#102b1c", "#ffffff"],
  dropped: ["#efd6db", "#672e3e"],
};
const key = (label) => String(label ?? "").trim().toLowerCase();
export function yearColors(label) {
  const year = String(label ?? "").toUpperCase().replace(/\s/g, "");
  return Object.hasOwn(years, year) ? years[year] : neutral;
}
export function flightColors(label, squadron) {
  const name = key(label), group = key(squadron);
  if (!name || name === "unassigned" || name === "abroad") return neutral;
  if (group === "blue") return Object.hasOwn(blue, name) ? blue[name] : blue.bravo;
  if (group === "gold") return Object.hasOwn(gold, name) ? gold[name] : gold.echo;
  return !group && Object.hasOwn(flights, name) ? flights[name] : neutral;
}
export function flightPathColors(label) {
  const status = key(label);
  return Object.hasOwn(paths, status) ? paths[status] : neutral;
}
export const cellStyle = ([background, color]) => ({
  backgroundColor: background,
  color,
});
const rateStops = ["#de887d", "#ecaf76", "#e8cc78", "#b5cd86", "#82ba91"];
export function rateStyle(value) {
  if (!Number.isFinite(value)) return cellStyle(neutral);
  const step = Math.min(4, Math.max(0, (value * 100 - 80) / 5));
  const i = Math.floor(step);
  const blend = (step - i) * 100;
  const backgroundColor = blend
    ? `color-mix(in oklab, ${rateStops[i]}, ${rateStops[i + 1]} ${blend}%)`
    : rateStops[i];
  return { backgroundColor, color: "#232820" };
}

// Group the configured two-digit CIP series for display. Six-digit codes share
// their series color. Reserved, missing, and unrecognized values use gray.
const cipFamilies = [
  [["04", "11", "14", "15", "27", "29", "40", "41"], ["#c2dfe6", "#143e49"]],
  [["01", "03"], ["#cddfc2", "#263e20"]],
  [["26", "31", "34", "51", "60", "61"], ["#f1c9ba", "#57271a"]],
  [["22", "52"], ["#ecd8a7", "#4f340a"]],
  [["05", "13", "19", "28", "32", "33", "35", "36", "37", "42", "43", "44", "45"], ["#ded5f0", "#3c2e5a"]],
  [["09", "10", "16", "23", "25", "38", "39", "50", "54"], ["#eacde0", "#532a47"]],
  [["12", "46", "47", "48", "49"], ["#d2cbd6", "#392c3d"]],
  [["24", "30", "53"], ["#cbd5e4", "#293b52"]],
];
const cipColors = new Map(cipFamilies.flatMap(([series, colors]) =>
  series.map((code) => [code, colors])));
const afscFills = new Map([
  ["1", "#284e86"], ["2", "#84541e"], ["3", "#216b65"], ["4", "#873f60"],
  ["5", "#59457c"], ["6", "#3d6270"], ["7", "#5d4633"], ["8", "#495566"],
  ["9", "#4c4c62"],
]);
export function profileColorStyle(field, value) {
  const label = String(value ?? "").trim();
  if (field === "cipBroadArea" || field === "cipCode") {
    const series = /^(\d{2})(?=$|\s|\.|[-–—])/.exec(label)?.[1];
    return cellStyle(cipColors.get(series) ?? neutral);
  }
  if (field === "afsc") {
    if (key(label) === "space force") return cellStyle(["#233656", "#ffffff"]);
    const group = /^([1-9])\d[A-Z](?:[\dX][A-Z]?)?(?=$|\s|[-–—])/i.exec(label)?.[1];
    const fill = afscFills.get(group);
    return cellStyle(fill ? [fill, "#ffffff"] : neutral);
  }
}
