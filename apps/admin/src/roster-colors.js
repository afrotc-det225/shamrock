// Fill, lettering, and chart ink. Cohorts within each group have comparable lightness.
const neutral = ["#e8ecf0", "#334254", "#657480"];
const years = {
  AS100: ["#c8e9e3", "#153d39", "#398378"],
  AS150: ["#c8e7ef", "#173b48", "#398399"],
  AS200: ["#dfd8f3", "#392d55", "#826baa"],
  AS250: ["#e8d7f0", "#46304f", "#966da3"],
  AS500: ["#f1dbce", "#513428", "#a36e51"],
  AS300: ["#286565", "#ffffff", "#286565"],
  AS400: ["#764a74", "#ffffff", "#764a74"],
  AS700: ["#365e80", "#ffffff", "#365e80"],
  AS800: ["#77513c", "#ffffff", "#77513c"],
  AS900: ["#575a80", "#ffffff", "#575a80"],
};
const blue = {
  alpha: ["#b6e6f1", "#153b4a", "#247890"],
  bravo: ["#c1d9f7", "#203954", "#406fb1"],
  charlie: ["#ccd1f6", "#333656", "#606cb1"],
};
const gold = {
  delta: ["#f4d5a7", "#493019", "#a36b28"],
  echo: ["#f2e2a7", "#463815", "#927521"],
  foxtrot: ["#f4c9a5", "#4e3020", "#af6235"],
};
export const yearColors = (label) =>
  years[String(label).toUpperCase().replace(/\s/g, "")] || neutral;
export function flightColors(label, squadron) {
  const family = { blue, gold }[String(squadron).toLowerCase()];
  return (
    family?.[String(label).toLowerCase()] ||
    (family === blue ? blue.bravo : family === gold ? gold.echo : neutral)
  );
}
export const cellStyle = ([background, color]) => ({
  backgroundColor: background,
  color,
});
const rateStops = [
  [232, 142, 138],
  [247, 199, 152],
  [249, 233, 177],
  [190, 225, 191],
  [111, 195, 161],
];
export function rateStyle(value) {
  if (!Number.isFinite(value)) return;
  const step = Math.min(4, Math.max(0, (value - 0.8) * 20)),
    i = Math.min(3, Math.floor(step));
  const rgb = rateStops[i].map((a, k) =>
    Math.round(a + (rateStops[i + 1][k] - a) * (step - i)),
  );
  return { backgroundColor: "rgb(" + rgb.join(",") + ")", color: "#192c33" };
}
