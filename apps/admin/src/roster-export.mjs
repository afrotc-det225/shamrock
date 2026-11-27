// Keep spreadsheet cells literal, including directory values that resemble formulas.
export function rosterText(headers, rows, separator) {
  const cell = value => {
    let text = String(value ?? "");
    if (/^\s*[=+@-]|^[\t\r\n]/u.test(text)) text = "'" + text;
    if (text.includes(separator) || /["\r\n]/.test(text)) return '"' + text.replaceAll('"', '""') + '"';
    return text;
  };
  return [headers, ...rows].map(row => row.map(cell).join(separator)).join("\r\n");
}
