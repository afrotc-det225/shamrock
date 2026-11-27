import React, {useState} from "react";
import {Select} from "./components";

const levels = [40, 50, 60, 70, 75, 80, 85, 90, 100, 110, 115, 125, 130, 150];
export function useTableZoom(table) {
  const key = "shamrock.tableZoom." + table;
  const [percent, setPercent] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      if (levels.includes(saved)) return saved;
    } catch {}
    return window.matchMedia("(max-width: 640px)").matches ? 50 : 100;
  });
  function update(value) {
    setPercent(Number(value));
    try { localStorage.setItem(key, value); } catch {}
  }
  return {scale:percent / 100, control:<Select label="Table zoom" value={String(percent)} onChange={update}
    options={levels.map(level => ({value:String(level), label:level+"%"}))}/>};
}
