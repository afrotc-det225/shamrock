import React, {useState} from "react";
import {compareCadetsForDisplay} from "../../../packages/domain/src/cadet-display-order";
import {Empty, Heading, SearchBox, Select, Table} from "./components";
import {ToolbarFilters} from "./ToolbarFilters";
import {cellStyle, flightColors, yearColors} from "./roster-colors";
import {useTableZoom} from "./TableZoom";

const directoryFields = [["role","Role"],["university","University"],["email","School email"],["classYear","Graduation year"],
  ["cipBroadArea","CIP broad area"],["cipCode","CIP code"],["afsc","AFSC"],["flightPathStatus","Status"]];

export default function CadetDirectory({rows}) {
  const [query,setQuery] = useState(""), [flight,setFlight] = useState("");
  const zoom = useTableZoom("cadets");
  const words = query.toLowerCase().trim().split(/[\s,]+/);
  const roster = rows.filter(row => (!flight || row.flight===flight)
    && words.every(word => [row.firstName,row.lastName,row.rank,row.asYear,row.flight,row.squadron,...directoryFields.map(([key])=>row[key])]
      .some(value => String(value ?? "").toLowerCase().includes(word)))).sort(compareCadetsForDisplay);
  return <>
    <section className="page-controls"><Heading title="Cadets"/><div className="toolbar">
      <SearchBox placeholder="Find a cadet" value={query} onChange={setQuery}/>
      <ToolbarFilters active={!!flight}><Select label="Flight" value={flight} onChange={setFlight}
        options={[{value:"",label:"All flights"},...Array.from(new Set(rows.map(row => row.flight))).sort()]}/>
        {zoom.control}
      </ToolbarFilters>
    </div></section>
    {roster.length ? <Table zoom={zoom.scale} headers={["Cadet","AS year","Flight","Squadron",...directoryFields.map(([,label])=>label)]}>
      {roster.map(row => <tr key={row.personId}><td>{row.rank} {row.firstName} {row.lastName}</td>
        <td style={cellStyle(yearColors(row.asYear))}>{row.asYear}</td>
        <td style={cellStyle(flightColors(row.flight,row.squadron))}>{row.flight}</td>
        <td>{row.squadron}</td>{directoryFields.map(([key])=><td key={key}>{row[key] || "—"}</td>)}</tr>)}
    </Table> : <Empty>No matching cadets.</Empty>}
  </>;
}
