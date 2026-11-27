import React from "react";
import { compareAsYearsForDisplay } from "../../../packages/domain/src/cadet-display-order";
import { alphabetic, textOrder } from "./RosterViews";
import { Select } from "./components";

export const defaultRosterFilters = { flight: "", year: "", sort: "seniority" };

function numericRate(value) {
  const rate = typeof value === "object" && value !== null
    ? (value.noCountedAttendance ? null : value.percentage)
    : value;
  if (typeof rate === "string" && /^\d+(?:\.\d+)?%$/.test(rate.trim()))
    return parseFloat(rate) / 100;
  return Number.isFinite(rate) ? rate : Infinity;
}

export function selectRosterRows(rows, query, {flight, year, sort}) {
  const search = query.trim().toLowerCase();
  const seniority = (a, b) =>
    compareAsYearsForDisplay(a.asYear || "", b.asYear || "") || alphabetic(a, b);
  return rows.filter(row => (!flight || row.flight === flight) && (!year || row.asYear === year) &&
    (!search || [row.firstName, row.lastName].filter(Boolean).join(" ").toLowerCase().includes(search)))
    .sort((a, b) => {
      if (sort === "flight") return textOrder(a.flight, b.flight) || seniority(a, b);
      if (sort === "overall") return numericRate(a.overall) - numericRate(b.overall) || alphabetic(a, b);
      return sort === "name" ? alphabetic(a, b) : seniority(a, b);
    });
}

export function MatrixRosterFilters({ rows, value, onChange }) {
  const options = (key, compare) => [...new Set(rows.map(row => row[key]).filter(Boolean))].sort(compare);
  const change = key => selected => onChange(previous => ({ ...previous, [key]: selected }));
  return <>
    <Select label="Flight" value={value.flight} onChange={change("flight")}
      options={[{value:"", label:"All Flights"}, ...options("flight", textOrder)]} />
    <Select label="AS year" value={value.year} onChange={change("year")}
      options={[{value:"", label:"All AS years"}, ...options("asYear", compareAsYearsForDisplay)]} />
    <Select label="Sort by" value={value.sort} onChange={change("sort")} options={[
      {value:"seniority", label:"Default"}, {value:"name", label:"Last name"},
      {value:"flight", label:"Flight"}, {value:"overall", label:"Lowest overall"},
    ]} />
  </>;
}
