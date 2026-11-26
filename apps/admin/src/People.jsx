import React, { useState,useEffect } from "react";
import { Plus, Pencil } from "lucide-react";
import {
  Heading,
  Field,
  Select,
  SearchBox,
  Editor,
  Table,
  Status,
  Empty,

} from "./components";
import { cellStyle, flightColors, yearColors } from "./roster-colors";
import { LeadershipChart, textOrder, alphabetic } from "./RosterViews";
import { api,name, label, years, statuses, profileFields } from "./api";
import { compareCadetsForDisplay, compareLeadershipForDisplay } from "../../../packages/domain/src/cadet-display-order";
export default function People({
  snapshot, list, withFullData, captureKey, manifest, viewAsRevision,
  propose,
  busy,
  leadership = false,
  readOnly = false,
}) {
  const s = snapshot || list;
  const [query, setQuery] = useState(""),
    [flight, setFlight] = useState(""),
    [edit, setEdit] = useState(null);
  const set = (k, v) => setEdit({ ...edit, [k]: v }),
    profile = (k, v) =>
      setEdit({ ...edit, profile: { ...edit.profile, [k]: v } });
  const open = (row) => {
    if (snapshot) return openRecord(row);
    return withFullData(full => {
      const record = row && (leadership ? full.leadership.find(c=>c.contactId===row.contactId) :
        full.people.find(p=>p.personId===row.personId));
      if (row && !record) throw Error("This record changed. Reload the page.");
      openRecord(record);
    });
  };
  const openRecord = (p) => {
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
  const visibleField = field && !leadership;
  const [extended,setExtended]=useState(null),[fieldError,setFieldError]=useState(""),[retry,setRetry]=useState(0);
  const extra = !snapshot && ["phone","dorm","homeTown","homeState","dateOfBirth","photoLink"].includes(field);
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
  const directory=extra ? extended?.binding===binding ? extended.people : [] : s.people;
  const rows = (leadership ? s.leadership : directory).filter(p=>{
    if (!leadership && (flight && p.flightId!==flight || year && p.asYear!==year ||
      status==="current" && ["Dropped","Commissioned"].includes(p.flightPathStatus) ||
      !["current","all"].includes(status) && p.flightPathStatus!==status ||
      field && match && !String(p[field] ?? "").toLowerCase().includes(match.toLowerCase()))) return false;
    return [name(p),p.email,p.role,p.rank].join(" ").toLowerCase().includes(query.toLowerCase());
  }).sort(leadership ? compareLeadershipForDisplay : (a,b)=>{
    if (sort==="name") return alphabetic(a,b);
    if (sort==="flight") return textOrder(flightOf(a)?.label,flightOf(b)?.label) || compareCadetsForDisplay(a,b);
    return compareCadetsForDisplay(a,b);
  });
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
      <Field
        key={k}
        label={label(k)}
        required={["firstName", "lastName"].includes(k)}
        type={k === "email" ? "email" : k === "dateOfBirth" ? "date" : "text"}
        value={edit.profile[k] ?? ""}
        onChange={(e) =>
          profile(
            k,
            k === "dateOfBirth" && !e.target.value ? null : e.target.value,
          )
        }
      />
    );
  }
  return (
    <>
      <section className="page-controls">
        <Heading title={leadership ? "Leadership" : "Cadets"}>
          <button className="primary" disabled={readOnly} onClick={() => open()}>
            <Plus size={17} />
            {leadership ? "Add contact" : "Add cadet"}
          </button>
        </Heading>
        <div className="toolbar">
          <SearchBox
            placeholder={leadership ? "Find a leader" : "Find a cadet"}
            value={query}
            onChange={setQuery}
          />
          {leadership ? <Select label="View" value={view} onChange={setView} options={["List","Organization"]}/> : <>
            <Select label="Flight" value={flight} onChange={setFlight} options={[{value:"",label:"All flights"},...s.flights.map(f=>({value:f.flightId,label:f.label})).sort((a,b)=>textOrder(a.label,b.label))]}/>
            <Select label="AS year" value={year} onChange={setYear} options={[{value:"",label:"All AS years"},...years]}/>
            <Select label="Roster status" value={status} onChange={setStatus} options={[{value:"current",label:"Current roster"},{value:"all",label:"All statuses"},...statuses]}/>
            <Select label="Sort by" value={sort} onChange={setSort} options={[{value:"seniority",label:"AS year, then name"},{value:"flight",label:"Flight, then AS year"},{value:"name",label:"Last name"}]}/>
          </>}
        </div>
        {!leadership && <details className="field-picker"><summary>More fields{field ? " · "+label(field) : ""}</summary>
          <div className="toolbar"><Select label="Show field" value={field} onChange={selectField} options={[{value:"",label:"Choose a field"},...profileFields.filter(k=>!["firstName","lastName","asYear","flightPathStatus"].includes(k)).map(k=>({value:k,label:label(k)}))]}/>
          {field && <Field label={"Filter by "+label(field)} value={match} onChange={e=>setMatch(e.target.value)}/>}</div></details>}
      </section>
      {extra && extended?.binding!==binding && <p role="status">{fieldError || "Loading directory fields…"} {fieldError && <button onClick={()=>setRetry(retry+1)}>Retry</button>}</p>}
      {(query || flight || year || match || !["current","all"].includes(status)) && <p className="result-count">{rows.length} {leadership?"contacts":"cadets"}</p>}
      {leadership && view==="Organization" ? <LeadershipChart records={rows} roster={s}/> : <Table
        headers={
          leadership
            ? ["Name", "Role", "Email", "Office", ""]
            : ["Name", "AS year", "Flight", "Status", ...(visibleField?[label(field)]:[]), ""]
        }
      >
        {rows.map((p) => (
          <tr key={p.contactId || p.personId}>
            <td>
              <div className="person-cell">
                <span className="initials" aria-hidden="true">
                  {p.firstName?.[0]}
                  {p.lastName?.[0]}
                </span>
                <span>
                  <button className="text-button" disabled={readOnly} onClick={() => open(p)}>
                    {name(p)}
                  </button>
                  <small>{p.rank}</small>
                </span>
              </div>
            </td>
            {leadership ? (
              <>
                <td>{p.role}</td>
                <td>{p.email}</td>
                <td>{p.officeLocation || "—"}</td>
              </>
            ) : (
              <>
                <td className="formation" style={cellStyle(yearColors(p.asYear))}>{p.asYear || "—"}</td>
                <td className="formation" style={cellStyle(flightColors(flightOf(p)?.label,squadronOf(flightOf(p))))}>
                  {flightOf(p)?.label || "Unassigned"}
                </td>
                <td>
                  <Status>{p.flightPathStatus}</Status>
                </td>
              </>
            )}
            {visibleField && <td>{String(p[field] || "—")}</td>}
            <td>
              <button
                className="icon"
                disabled={readOnly}
                aria-label={`Edit ${name(p)}`}
                onClick={() => open(p)}
              >
                <Pencil size={16} />
              </button>
            </td>
          </tr>
        ))}
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
              <details>
                <summary>Academic, personal & photo details</summary>
                {profileFields.filter((k) => !basic.includes(k)).map(input)}
              </details>
            </>
          )}
          {leadership && (
            <>
              {["reportsTo", "officePhone", "officeLocation"].map((k) => (
                <Field
                  key={k}
                  label={label(k)}
                  value={edit[k]}
                  onChange={(e) => set(k, e.target.value)}
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
