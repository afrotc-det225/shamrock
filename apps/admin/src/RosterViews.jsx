export const textOrder = (a, b) =>
  String(a || "").localeCompare(String(b || ""), "en", {
    numeric: true,
    sensitivity: "base",
  });
export const alphabetic = (a, b) =>
  textOrder(a.lastName, b.lastName) ||
  textOrder(a.firstName, b.firstName) ||
  textOrder(a.personId, b.personId);
