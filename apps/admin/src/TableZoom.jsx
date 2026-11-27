import React, {useState} from "react";
import {Select} from "./components";

const levels = [60, 75, 85, 100, 115, 130];
export function useTableZoom(table) {
  const key = "shamrock.tableZoom." + table;
  const [percent, setPercent] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      if (levels.includes(saved)) return saved;
    } catch {}
    return 100;
  });
  function update(value) {
    setPercent(Number(value));
    try { localStorage.setItem(key, value); } catch {}
  }
  return {scale:percent / 100, control:<Select label="Table zoom" value={String(percent)} onChange={update}
    options={levels.map(level => ({value:String(level), label:level+"%"}))}/>};
}
