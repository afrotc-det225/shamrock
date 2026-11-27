import {useTableZoom} from "./TableZoom";
import { ToolbarFilters } from "./ToolbarFilters";
import React, { useState,useEffect } from "react";
import { Plus, Pencil, Columns3 } from "lucide-react";
import {
  Heading,
  Field,
  Select,
  SearchBox,
  Editor,
  Table,
  Empty,

} from "./components";
import { rosterText } from "./roster-export.mjs";
import { ProfileField } from "./ProfileField";
import { DirectoryPhoto } from "./DirectoryPhoto";
import { ToolbarPopover } from "./ToolbarPopover";
import { cellStyle, flightColors, flightPathColors, profileColorStyle, residenceCategory, yearColors } from "./roster-colors";
import { LeadershipChart, textOrder, alphabetic } from "./RosterViews";
import { api,name, label, years, statuses, profileFields } from "./api";
import { DIRECTORY_FIELDS } from "../../../packages/domain/src/admin";
import { compareAsYearsForDisplay, compareCadetsForDisplay, compareLeadershipForDisplay } from "../../../packages/domain/src/cadet-display-order";

const coreColumns = ["cadet","asYear","flight","squadron","flightPathStatus"];
const columnKeys = ["cadet","lastName","firstName","rank","asYear","flight","squadron","flightPathStatus",
  ...profileFields.filter(k => !["lastName","firstName","rank",...coreColumns].includes(k))];
const defaultColumns = columnKeys.filter(key => !["lastName","firstName","rank"].includes(key));
const columnLabel = k=>({cadet:"Cadet",lastName:"Last name",firstName:"First name",flight:"Flight",squadron:"Squadron",flightPathStatus:"Status",classYear:"Graduation year"}[k] || label(k));
const detailFields = new Set(["phone","dorm","homeTown","homeState","dateOfBirth"]);
const preferenceKey = "shamrock.cadets.columns.v2";
function initialColumns(){
  try {
    const saved=localStorage.getItem(preferenceKey);
    const keys=JSON.parse(saved ?? localStorage.getItem("shamrock.cadets.columns.v1"));
    if(Array.isArray(keys)) {
      const selected=columnKeys.filter(k=>keys.includes(k) || (!saved && k==="cadet"));
      if(selected.length)return selected;
    }
  } catch {}
  return defaultColumns;
}

export function cadetBrowseProfile() {
  return initialColumns().some(key => detailFields.has(key)) ? "cadet-details" : "cadets";
}

function DirectoryValue({ field, value, person }) {
  if (field === "photoLink") return value ? <DirectoryPhoto value={value} person={person} /> : "—";
  const style = profileColorStyle(field, value);
  const label = String(value || "—");
  return style ? <span className="profile-tag" style={style} title={field==="dorm" && value ? residenceCategory(value) : undefined}>{label}</span> : label;
}

export default function People({
  snapshot, list, browse, run, captureKey, manifest, viewAsRevision,
  propose,
  busy,
  leadership = false,
  readOnly = false,
}) {
  const s = snapshot || list;
  const [query, setQuery] = useState(""),
    [flight, setFlight] = useState(""),
    [squadron, setSquadron] = useState(""),
    [edit, setEdit] = useState(null);
  const set = (k, v) => setEdit({ ...edit, [k]: v }),
    profile = (k, v) =>
      setEdit({ ...edit, profile: { ...edit.profile, [k]: v } });
  const [original,setOriginal] = useState(null);
  const complete = snapshot || browse?.profile === "cadet-details";
  const open = (row) => {
    if (!row || complete || leadership) return openRecord(row);
    const detailed = extended?.binding===binding && extended.people.find(p=>p.personId===row.personId);
    if (detailed) return openRecord(detailed);
    return run(async () => {
      const view=await api("/cadets/editor?id="+encodeURIComponent(row.personId));
      const [values]=JSON.parse(view.tables.people);
      if (!values || values[0]!==row.personId || values.length!==DIRECTORY_FIELDS.length+3)
        throw Error("This record changed. Reload the page.");
      openRecord(Object.fromEntries(["personId","version","flightId",...DIRECTORY_FIELDS].map((key,i)=>[key,values[i]])));
    });
  };
  const openRecord = (p) => {
    setOriginal(p);
    if (leadership)
      setEdit({
        contactId: p?.contactId || crypto.randomUUID(),
        expectedVersion: p?.contactVersion || 0,
        personId: p?.personId || null,
        profile: p?.personId
          ? null
          : Object.fromEntries(
              [
                "firstName",
                "lastName",
                "rank",
                "role",
                "email",
                "cellPhone",
              ].map((k) => [k, p?.[k] || ""]),
            ),
        reportsTo: p?.reportsTo || "",
        officePhone: p?.officePhone || "",
        officeLocation: p?.officeLocation || "",
        active: p?.active ?? true,
      });
    else
      setEdit({
        personId: p?.personId || crypto.randomUUID(),
        expectedVersion: p?.version || 0,
        flightId: p?.flightId || null,
        profile: Object.fromEntries(
          profileFields.map((k) => [
            k,
            k === "dateOfBirth"
              ? (p?.[k] ?? null)
              : (p?.[k] ??
                {
                  asYear: "AS100",
                  flightPathStatus: "Active 3/4",
                }[k] ??
                ""),
          ]),
        ),
      });
  };
  const [sort,setSort]=useState("seniority"), [status,setStatus]=useState("current"), [year,setYear]=useState(""),
    [field,setField]=useState(""), [match,setMatch]=useState(""), [view,setView]=useState("List");
  const flightOf = p => s.flights.find(f=>f.flightId===p.flightId);
  const squadronOf = f => s.squadrons?.find(q=>q.squadronId===f?.squadronId)?.label;
  const rosterFlights = s.flights.filter(f => !squadron || f.squadronId === squadron);
  function changeSquadron(id) {
    setSquadron(id);
    if (id && !s.flights.some(f => f.flightId === flight && f.squadronId === id)) setFlight("");
  }
  const zoom = useTableZoom("cadets");
  const [columns,setColumns]=useState(initialColumns), [descending,setDescending]=useState(false);
  const [transferMessage,setTransferMessage]=useState("");
  const hasCadet = columns.includes("cadet");
  function valueOf(person, key) {
    if (key === "cadet") return [person.rank, name(person)].filter(Boolean).join(" ");
    if (key === "flight") return flightOf(person)?.label;
    if (key === "squadron") return squadronOf(flightOf(person));
    return person[key];
  }
  function toggleColumn(key){
    const shown=columns.includes(key);
    const next=columnKeys.filter(k=>k===key ? !shown : columns.includes(k));
    if (!next.length) return;
    setTransferMessage("");
    setColumns(next);
    try{localStorage.setItem(preferenceKey,JSON.stringify(next));}catch{}
    if (shown && field === key) selectField("");
    if (!shown && !match) selectField(key);
  }
  function headerSort(key){
    setDescending(sort===key && !descending);
    setSort(key);
  }
  function header(key,title){
    return <button className="roster-sort" type="button" aria-label={"Sort by "+title} onClick={()=>headerSort(key)}>
      {title}{sort===key && (descending ? " ↓" : " ↑")}
    </button>;
  }
  const [extended,setExtended]=useState(null),[fieldError,setFieldError]=useState(""),[retry,setRetry]=useState(0);
  const extra = !leadership && !complete && [...columns,sort,field].some(k=>detailFields.has(k));
  const binding=JSON.stringify([captureKey,manifest?.revision,viewAsRevision]);
  useEffect(()=>{
    if(!extra || extended?.binding===binding)return;
    const controller=new AbortController();
    setFieldError("");
    api("/state",undefined,{profile:"cadet-details",signal:controller.signal}).then(data=>{
      if(JSON.stringify([data.captureKey,data.manifest?.revision,data.viewAsRevision])!==binding)throw Error("Directory access or records changed. Refresh the page.");
      setExtended({binding,people:data.list?.people || data.snapshot.people});
    }).catch(e=>{if(!controller.signal.aborted)setFieldError(e.message);});
    return ()=>controller.abort();
  },[extra,binding,extended?.binding,retry]);
  const waitingForField = extra && extended?.binding !== binding;
  const directory = extra && !waitingForField ? extended.people : s.people;
  const rows = (leadership ? s.leadership : directory).filter(p=>{
    if (!leadership && (squadron && flightOf(p)?.squadronId !== squadron || flight && p.flightId!==flight || year && p.asYear!==year ||
      status==="current" && ["Dropped","Commissioned"].includes(p.flightPathStatus) ||
      !["current","all"].includes(status) && p.flightPathStatus!==status ||
      field && match && !waitingForField && !String(valueOf(p,field) ?? "").toLowerCase().includes(match.toLowerCase()))) return false;
    return [name(p),p.email,p.role,p.rank].join(" ").toLowerCase().includes(query.toLowerCase());
  }).sort(leadership ? compareLeadershipForDisplay : (a,b)=>{
    if(sort==="seniority")return compareCadetsForDisplay(a,b);
    const direction=descending ? -1 : 1;
    if(sort==="cadet")return direction*alphabetic(a,b);
    const left=valueOf(a,sort),right=valueOf(b,sort);
    if(!left || !right)return Number(!left)-Number(!right) || alphabetic(a,b);
    const order=sort==="asYear" ? compareAsYearsForDisplay(left,right) : textOrder(left,right);
    return direction*order || (sort==="flight" ? compareCadetsForDisplay(a,b) : alphabetic(a,b));
  });
  async function transferRoster(format) {
    const copy = format === "clipboard";
    const text=rosterText(columns.map(columnLabel), rows.map(p=>columns.map(k=>valueOf(p,k))),copy ? "\t" : ",");
    if (copy) {
      try {
        await navigator.clipboard.writeText(text);
        setTransferMessage("Copied to clipboard.");
      } catch { setTransferMessage("Clipboard access is unavailable. Use Download CSV."); }
      return;
    }
    const url=URL.createObjectURL(new Blob([text], {type:"text/csv;charset=utf-8"}));
    const link=document.createElement("a");
    link.href=url;
    link.download="shamrock-cadets.csv";
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  const selectField = key => {setField(key);setMatch("");};
  const basic = leadership
    ? ["firstName", "lastName", "rank", "role", "email", "cellPhone"]
    : [
        "firstName",
        "lastName",
        "asYear",
        "rank",
        "role",
        "email",
        "phone",
        "flightPathStatus",
      ];
  function input(k) {
    return k === "asYear" || k === "flightPathStatus" ? (
      <Select
        key={k}
        label={label(k)}
        value={edit.profile[k]}
        onChange={(v) => profile(k, v)}
        options={k === "asYear" ? years : statuses}
      />
    ) : (
      <ProfileField key={k} field={k} label={label(k)} original={original?.[k]}
        broadArea={k === "cipCode" ? edit.profile.cipBroadArea : undefined} originalBroadArea={k === "cipCode" ? original?.cipBroadArea : undefined}
        required={["firstName","lastName"].includes(k)} value={edit.profile[k] ?? ""}
        onChange={value => profile(k,k === "dateOfBirth" && !value ? null : value)}/>
    );
  }
  const dataColumns = columns.filter(key => key !== "cadet");
  return (
    <>
      <section className="page-controls">
        <Heading title={leadership ? "Leadership" : "Cadets"} />
        <div className="toolbar">
          <SearchBox
            placeholder={leadership ? "Find a leader" : "Find a cadet"}
            value={query}
            onChange={setQuery}
            resultCount={query || squadron || flight || year || match || !["current","all"].includes(status) ? rows.length : undefined}
          />
          <ToolbarFilters active={Boolean(squadron || flight || year || status !== "current" || sort !== "seniority" || view !== "List")}>
            {leadership ? <Select label="View" value={view} onChange={setView} options={["List","Organization"]}/> : <>
              <Select label="Squadron" value={squadron} onChange={changeSquadron} options={[
                {value:"",label:"Entire wing"},...(s.squadrons || []).map(q=>({value:q.squadronId,label:q.label})).sort((a,b)=>textOrder(a.label,b.label))
              ]}/>
              <Select label="Flight" value={flight} onChange={setFlight} options={[{value:"",label:"All flights"},...rosterFlights.map(f=>({value:f.flightId,label:f.label})).sort((a,b)=>textOrder(a.label,b.label))]}/>
              <Select label="AS year" value={year} onChange={setYear} options={[{value:"",label:"All AS years"},...years]}/>
              <Select label="Roster status" value={status} onChange={setStatus} options={[{value:"current",label:"Current roster"},{value:"all",label:"All statuses"},...statuses]}/>
              <Select label="Sort by" value={sort} onChange={key=>{setSort(key);setDescending(false);}} options={[{value:"seniority",label:"Default"},...columnKeys.map(k=>({value:k,label:columnLabel(k)}))]}/>
            </>}
            {zoom.control}
          </ToolbarFilters>
          <div className="toolbar-actions">
            {!leadership && (
              <ToolbarPopover label="Columns" icon={Columns3}>
                <div className="field-options">
                  <div className="directory-columns">{columnKeys.map(key=><label key={key}>
                    <input type="checkbox" checked={columns.includes(key)} disabled={columns.length===1 && columns[0]===key} onChange={()=>toggleColumn(key)}/>{columnLabel(key)}
                  </label>)}</div>
                  <Select label="Filter column" value={field} onChange={selectField} options={[
                    {value:"",label:"Choose a column"}, ...columns.map(k=>({value:k,label:columnLabel(k)}))
                  ]}/>
                  {field && <Field label={"Filter by "+columnLabel(field)} disabled={waitingForField} value={match} onChange={e=>setMatch(e.target.value)}/>}
                  <div className="roster-transfer">
                    <button disabled={waitingForField} onClick={()=>transferRoster("clipboard")}>Copy table</button>
                    <button disabled={waitingForField} onClick={()=>transferRoster("csv")}>Download CSV</button>
                  </div>
                  {transferMessage && <small role="status">{transferMessage}</small>}
                </div>
              </ToolbarPopover>
            )}
            <button className="primary" aria-label={leadership ? "Add contact" : "Add cadet"} title={leadership ? "Add contact" : "Add cadet"} disabled={readOnly} onClick={() => open()}>
              <Plus size={17} />
              <span>{leadership ? "Add contact" : "Add cadet"}</span>
            </button>
          </div>
        </div>

      </section>
      {waitingForField && (fieldError
        ? <p role="alert">{fieldError} <button onClick={()=>setRetry(retry+1)}>Retry</button></p>
        : <span className="page-transfer" role="status">Loading directory fields…</span>)}
      {leadership && view==="Organization" ? <LeadershipChart records={rows} roster={s}/> : <Table zoom={zoom.scale}
        className={leadership ? "leadership-roster" : hasCadet ? "cadet-roster with-cadet" : "cadet-roster"}
        headers={
          leadership
            ? ["Name", "Role", "Email", "Office", ""]
            : [...columns.map(k=>header(k,columnLabel(k))), ...(hasCadet ? [""] : [])]
        }
      >
        {rows.map((p) => {
          const editButton = <button className="icon" disabled={readOnly} aria-label={`Edit ${name(p)}`} onClick={() => open(p)}><Pencil size={16}/></button>;
          return (
          <tr key={p.contactId || p.personId}>
            {(leadership || hasCadet) && <td>
              <div className="person-cell">
                <DirectoryPhoto avatar value={p.photoLink} person={p} />
                <span>
                  <button className="text-button" disabled={readOnly} onClick={() => open(p)}>
                    {name(p)}
                  </button>
                  <small>{p.rank}</small>
                </span>
              </div>
            </td>}
            {leadership ? (
              <>
                <td>{p.role}</td>
                <td>{p.email}</td>
                <td>{p.officeLocation || "—"}</td>
              </>
            ) : (
              dataColumns.map(key=>{
                const value=valueOf(p,key);
                const formation=key==="flight" || key==="asYear";
                const style=key==="flight" ? cellStyle(flightColors(value,squadronOf(flightOf(p)))) :
                  key==="asYear" ? cellStyle(yearColors(value)) : undefined;
                return <td key={key} className={formation ? "formation" : undefined} style={style}>
                  {formation ? value || (key==="flight" ? "Unassigned" : "—") :
                    key==="flightPathStatus" ? <span className="status" style={cellStyle(flightPathColors(value))}>{value || "—"}</span> :
                    <DirectoryValue field={key} value={value} person={p}/>}
                  {key===columns[0] && !readOnly && editButton}
                </td>;
              })
            )}
            {(leadership || hasCadet) && <td>{editButton}</td>}
          </tr>
        );})}
      </Table>}
      {!rows.length && <Empty>No records match your search.</Empty>}
      {edit && (
        <Editor
          title={leadership ? "Leadership contact" : "Cadet profile"}
          busy={busy}
          onClose={() => setEdit(null)}
          onSubmit={() =>
            propose(
              leadership ? "leadership.upsert" : "directory.upsert",
              edit,
              () => setEdit(null),
            )
          }
          note={
            leadership
              ? "Leadership titles do not automatically grant system access."
              : ""
          }
        >
          {edit.profile ? (
            basic.map(input)
          ) : (
            <p>
              This contact is linked to a cadet. Edit their name, email and role
              in Cadets.
            </p>
          )}
          {!leadership && (
            <>
              <Select
                label="Flight"
                value={edit.flightId}
                onChange={(v) => set("flightId", v || null)}
                options={[
                  { value: "", label: "Unassigned" },
                  ...s.flights.map((f) => ({
                    value: f.flightId,
                    label: f.label,
                  })),
                ]}
              />
              <DirectoryPhoto value={edit.profile.photoLink} person={edit.profile} personId={edit.personId} />
              <details>
                <summary>Academic, personal & photo details</summary>
                {profileFields.filter((k) => !basic.includes(k)).map(input)}
              </details>
            </>
          )}
          {leadership && (
            <>
              {["reportsTo", "officePhone", "officeLocation"].map((k) => (
                <ProfileField field={k} original={original?.[k]}
                  key={k}
                  label={label(k)}
                  value={edit[k]}
                  onChange={value => set(k, value)}
                />
              ))}
              <label className="check">
                <input
                  type="checkbox"
                  checked={edit.active}
                  onChange={(e) => set("active", e.target.checked)}
                />
                Active contact
              </label>
            </>
          )}
        </Editor>
      )}
    </>
  );
}
