import React, {useEffect, useState} from "react";
import {usePhone} from "./use-phone";
import Attendance from "./Attendance";
import HistoricalAttendance from "./History";
import {api} from "./api";
import {Empty, LoadingRows} from "./components";

export default function AttendancePage({archivesAllowed, archiveVersion, onSemester, ...current}) {
  const phone = usePhone();
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  // A direct link to the latest archive can load its catalog and report together.
  const [includeLatest] = useState(archiveVersion === "latest");

  useEffect(() => {
    if (!archivesAllowed) return;
    const controller = new AbortController();
    const {signal} = controller;
    setError("");
    api("/history/list" + (includeLatest ? "?include=latest" : ""), undefined, {signal})
      .then(result => {
        if (signal.aborted) return;
        const options = result.semesters
          ? result.semesters.map(s => ({value:s.version, label:s.label, file:true})).reverse()
          : result.snapshots.map(s => ({value:s.snapshotId, label:s.periodLabel || s.title}));
        setCatalog({options, latest:result.latest});
      })
      .catch(e => { if (!signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [archivesAllowed, includeLatest, attempt]);

  if (archiveVersion && !archivesAllowed) return <Empty>This archived semester is unavailable.</Empty>;
  const item = archiveVersion === "latest"
    ? catalog?.options[0]
    : catalog?.options.find(option => option.value === archiveVersion);
  const picker = archivesAllowed && <label className="field semester-picker">
    <span>Semester</span>
    <select aria-label="Semester" disabled={current.busy && !archiveVersion}
      value={archiveVersion ? item?.value || "unavailable" : ""}
      onChange={event => onSemester(event.target.value)}>
      <option value="">{phone ? "This semester" : "Current semester"}</option>
      {archiveVersion && !item && <option disabled value="unavailable">{catalog ? "Unavailable archive" : "Archived semester"}</option>}
      {!!catalog?.options.length && <optgroup label="Archived semesters">
        {catalog.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </optgroup>}
    </select>
  </label>;

  return <>
    {archiveVersion
      ? <HistoricalAttendance key={item?.value || archiveVersion} item={item} semesterPicker={picker}
          initialReport={item && catalog?.latest?.version === item.value ? catalog.latest.report : null}/>
      : <Attendance {...current} semesterPicker={picker}/>}
    {archivesAllowed && error && <p role="alert">Archived semesters could not be loaded. <button onClick={() => retry(n => n + 1)}>Retry</button></p>}
    {archiveVersion && !catalog && !error && <LoadingRows label="Loading historical attendance" rows={7}/>}
    {archiveVersion && !item && catalog && <Empty>This archived semester is unavailable.</Empty>}
  </>;
}
