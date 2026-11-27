import React, { useLayoutEffect, useRef, useState } from "react";
import { List } from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";
import { rateStyle } from "./roster-colors";

const meanings = {
  P: "Present",
  T: "Tardy",
  A: "Absent, unresolved",
  R: "Request pending",
  D: "Request denied, attendance required",
  U: "Unexcused absence",
  E: "Excused",
  ES: "Excused for sport",
  MED: "Medical",
  "N/A": "Not applicable",
};
export function AttendanceKey() {
  return (
    <ToolbarPopover
      label="Attendance code key"
      shortLabel="Code key"
      icon={List}
    >
      <dl className="code-key">
        {Object.entries(meanings).map(([code, meaning]) => (
          <div key={code}>
            <dt data-mark={code}>{code}</dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
    </ToolbarPopover>
  );
}

function eventHeading(event) {
  const label = (event.columnLabel || event.label).trim();
  if (
    event.trainingWeek != null &&
    /^(mando|secondary|llab)$/.test(event.eventType) &&
    /TW[ -]?\d/i.test(label)
  )
    return [
      "TW-" + event.trainingWeek,
      { llab: "LLAB", secondary: "Secondary", mando: "Mando" }[event.eventType],
    ];
  const weekly = /^(?:TW[ -]?(\d+)\s+(Mando|Secondary|LLAB)|(Mando|Secondary|LLAB)\s+TW[ -]?(\d+))$/i.exec(label.trim());
  if (weekly) return ["TW-" + (weekly[1] || weekly[4]), weekly[2] || weekly[3]];
  const words = label.split(/\s+/);
  let cut = 1;
  for (let i = 2; i < words.length; i++)
    if (
      Math.abs(words.slice(0, i).join(" ").length - label.length / 2) <
      Math.abs(words.slice(0, cut).join(" ").length - label.length / 2)
    )
      cut = i;
  return [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
}

function moveFocus(e, select) {
  const direction = {
    ArrowRight: [0, 1],
    ArrowLeft: [0, -1],
    ArrowDown: [1, 0],
    ArrowUp: [-1, 0],
  }[e.key];
  if (!direction || !e.target.matches("button[data-event]")) return;
  e.preventDefault();
  const cell = e.target.closest("td"),
    row = cell.parentElement,
    rows = row.parentElement.rows;
  let r = row.sectionRowIndex,
    c = cell.cellIndex;
  while (true) {
    r += direction[0];
    c += direction[1];
    if (r < 0 || r >= rows.length || c < 0 || c >= rows[r].cells.length) return;
    if (!rows[r].cells[c].hasAttribute("data-mark")) return;
    const next = rows[r].cells[c].querySelector("button");
    if (next) {
      next.focus();
      if (e.shiftKey) select(next,e,cell);
      return;
    }
  }
}
export function AttendanceMatrix(props) {
  // A different visible roster or event order starts a fresh selection.
  const key=JSON.stringify([props.rows.map(r=>r.personId),props.events.map(e=>e.eventId)]);
  return <SelectableMatrix key={key} {...props}/>;
}

function SelectableMatrix({rows, events, canCorrect, onSelection, readOnly}) {
  const focused = useRef(null), anchor=useRef(null), activeAxis=useRef(null);
  const [selection,setSelection]=useState(()=>new Set());
  const cols=events.length;
  function update(next) {
    setSelection(next);
    const targets=[...next].map(position=>{
      const row=rows[Math.floor(position/cols)], event=events[position%cols];
      return {row,event,cell:row.cells.find(cell=>cell.eventId===event.eventId)};
    });
    onSelection(!readOnly && targets.every(t=>t.cell?.eligible && canCorrect(t.row)) ? targets : []);
  }
  function select(button,event,origin) {
    const td=button.closest("td"), row=td.parentElement.sectionRowIndex, col=td.cellIndex-3;
    const toggle=event.ctrlKey || event.metaKey || event.nativeEvent?.pointerType==="touch", pos=row*cols+col;
    if(event.shiftKey && anchor.current===null && origin)
      anchor.current=origin.parentElement.sectionRowIndex*cols+origin.cellIndex-3;
    const next=toggle ? new Set(selection) : new Set();
    if(event.shiftKey && anchor.current!==null) {
      const start=anchor.current, r=Math.floor(start/cols), c=start%cols;
      for(let y=Math.min(row,r);y<=Math.max(row,r);y++)
        for(let x=Math.min(col,c);x<=Math.max(col,c);x++) next.add(y*cols+x);
    } else {
      anchor.current=pos;
      if(toggle && next.has(pos))next.delete(pos);else next.add(pos);
    }
    update(next);
  }
  // Pointer movement touches only the old and new axes, without rerendering the matrix.
  function highlight(cell) {
    if(activeAxis.current===cell)return;
    const previous=activeAxis.current;
    if(previous?.parentElement !== cell?.parentElement){
      previous?.parentElement.classList.remove("matrix-active-row");
      cell?.parentElement.classList.add("matrix-active-row");
    }
    if(previous?.cellIndex !== cell?.cellIndex){
      const table=(cell || previous)?.closest("table");
      for(const row of table?.rows || []){
        if(previous)row.cells[previous.cellIndex]?.classList.remove("matrix-active-column");
        if(cell)row.cells[cell.cellIndex]?.classList.add("matrix-active-column");
      }
    }
    activeAxis.current=cell;
  }
  function clear(){anchor.current=null;update(new Set());}
  return <div onPointerOver={e=>highlight(e.target.closest("td.mark-cell"))}
    onPointerLeave={()=>highlight(null)} onFocus={e=>highlight(e.target.closest("td.mark-cell"))}
    onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))highlight(null);}}>
    <MatrixTable events={events} label="Attendance" onKeyDown={e=>{
      if(e.key==="Escape"){clear();return;}
      moveFocus(e,select);
    }}>
      {rows.map((row,rowIndex) => {
        const byEvent = new Map(row.cells.map((c) => [c.eventId, c]));
        return (
          <tr key={row.personId}>
            <th scope="row">
              {[row.firstName, row.lastName].filter(Boolean).join(" ")}
            </th>
            {[row.overall, row.llab].map((r, i) => {
              const v = r?.noCountedAttendance ? null : r?.percentage;
              return (
                <td key={i} className="matrix-percent" style={rateStyle(v)}>
                  {Number.isFinite(v) ? (100 * v).toFixed(1) + "%" : "—"}
                </td>
              );
            })}
            {events.map((e,colIndex) => {
              const c = byEvent.get(e.eventId);
              const code = c?.effectiveCode || "",
                label =
                  code ||
                  (c?.eligible === true
                    ? "Blank"
                    : c?.eligible === false
                      ? "Not eligible"
                      : "Eligibility unknown");
              const description = [
                row.firstName + " " + row.lastName,
                e.label,
                meanings[code] ? code + " · " + meanings[code] : label,
                c?.needsReview ? "Needs review" : "",
              ]
                .filter(Boolean)
                .join(", ");
              const content = code || (c?.eligible === true ? "·" : "—");
              const selected=selection.has(rowIndex*cols+colIndex);
              return (
                <td
                  key={e.eventId}
                  className="mark-cell"
                  data-selected={selected || undefined}
                  data-mark={
                    code || (c?.eligible === true ? "blank" : "excluded")
                  }
                  data-review={c?.needsReview ? "true" : undefined}
                  title={description}
                >
                  <button
                      type="button"
                      data-event={e.eventId}
                      tabIndex={focused.current ? (focused.current.dataset.person===row.personId && focused.current.dataset.event===e.eventId?0:-1) : (rowIndex===0 && colIndex===0?0:-1)}
                      data-person={row.personId} aria-pressed={selected}
                      aria-label={description}
                      onFocus={(ev) => {
                        if (focused.current?.isConnected)
                          focused.current.tabIndex = -1;
                        ev.currentTarget.tabIndex = 0;
                        focused.current = ev.currentTarget;
                      }}
                      onClick={ev=>select(ev.currentTarget,ev)}
                      onContextMenu={ev=>{
                        // macOS delivers Control-click as a contextual click.
                        if(ev.ctrlKey && ev.button===0){ev.preventDefault();select(ev.currentTarget,ev);}
                      }}
                    >
                      {content}
                    </button>
                </td>
              );
            })}
          </tr>
        );
      })}
    </MatrixTable>
  </div>;
}

export function MatrixTable({events, label, onKeyDown, children}) {
  const viewport=useRef(null);
  useLayoutEffect(()=>{
    const el=viewport.current;
    const resize=()=>{
      const top=el.getBoundingClientRect().top;
      el.style.maxHeight=Math.max(160,window.innerHeight-Math.max(0,top)-8)+"px";
    };
    resize();
    const observer=new ResizeObserver(resize);
    for(const control of el.closest("main")?.querySelectorAll(".page-controls,.notice") || [])observer.observe(control);
    window.addEventListener("resize",resize);
    return ()=>{observer.disconnect();window.removeEventListener("resize",resize);};
  },[]);
  return (
    <div
      ref={viewport} className="matrix-scroll"
      tabIndex={0}
      aria-label={label + " matrix"}
    >
      <table
        className="attendance-matrix"
        aria-label={label}
        style={{ width: 282 + 68 * events.length }}
        onKeyDown={onKeyDown}
      >
        <colgroup>
          <col style={{ width: 152 }} />
          <col span="2" style={{ width: 65 }} />
          {events.length > 0 && (
            <col span={events.length} style={{ width: 68 }} />
          )}
        </colgroup>
        <thead>
          <tr>
            {["Cadet", "Overall", "LLAB"].map((h) => (
              <th scope="col" key={h}>
                {h}
              </th>
            ))}
            {events.map((e) => (
              <th scope="col" key={e.eventId} title={e.label}>
                {eventHeading(e).map((line, i) => (
                  <span className="event-line" key={i}>
                    {line}
                  </span>
                ))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {children}
        </tbody>
      </table>
    </div>
  );
}
