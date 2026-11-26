import React, { useState } from 'react';
import { Drawer, Field, Select, Table } from './components';
import { api, displayDate, eventTypes } from './api';
import { meetingDefault, rescheduleEvent } from './schedule.mjs';
import { toEastern, zoneLabel } from './time';

export default function BulkSchedule({snapshot:s, term, onClose, onSaved}) {
  const [type,setType]=useState('mando'), [from,setFrom]=useState(toEastern(new Date().toISOString()).slice(0,10));
  const [meeting,setMeeting]=useState(() => meetingDefault(s.events.filter(e=>e.termId===term),'mando',{weekday:4,hour:6,minute:30,durationMinutes:60}));
  const [plan,setPlan]=useState(null), [saving,setSaving]=useState(false), [error,setError]=useState('');
  const rows=s.events.filter(e=>e.termId===term&&e.eventType===type&&e.status==='active'&&e.startAt&&toEastern(e.startAt).slice(0,10)>=from);
  const review=e=>{
    e.preventDefault();setError('');
    try {
      if(!rows.length||rows.length>100) throw new Error('Select between 1 and 100 events.');
      setPlan(rows.map(event=>{
        if(!Array.isArray(event.eligiblePersonIds)) throw new Error('Review the attendance roster before rescheduling this event.');
        const payload=Object.fromEntries(['eventId','termId','eventType','trainingWeek','displayOrder','label','columnLabel','expectedGroup','status','location','notes','eligiblePersonIds'].map(k=>[k,event[k]]));
        return {label:event.label,before:event.startAt,payload:{...payload,expectedVersion:event.version,flightIds:s.eventFlights.filter(f=>f.eventId===event.eventId).map(f=>f.flightId),...rescheduleEvent(event,meeting)}};
      }));
    } catch(e){setError(e.message);}
  };
  const save=async()=>{
    setSaving(true);setError('');const next=plan.map(p=>({...p}));
    try {
      for(const item of next){
        if(item.done)continue;
        if(!item.id) { item.id=(await api('/proposals',{operation:'event.upsert',payload:item.payload})).id; setPlan(next.map(p=>({...p}))); }
        await api(`/proposals/${item.id}/apply`,{approved:true});
        item.done=true;setPlan(next.map(p=>({...p})));
      }
      await onSaved();onClose();
    }catch(e){setError(`${next.filter(p=>p.done).length} of ${next.length} saved. ${e.message}`);}
    finally{setSaving(false);}
  };
  return <Drawer title="Change event schedule" onClose={()=>!saving&&onClose()}>
    {plan ? <><div className="fields">
      <Table headers={['Event','Current date','New date','Status']}>{plan.map(p=><tr key={p.payload.eventId}><td>{p.label}</td><td>{displayDate(p.before)}</td><td>{displayDate(p.payload.startAt)}</td><td>{p.done?'Saved':'Pending'}</td></tr>)}</Table>
      <p>Events save separately. Saved changes remain if an update is interrupted.</p>
      {error&&<p role="alert" className="error">{error}</p>}
    </div><footer className="actions"><button disabled={saving} onClick={onClose}>Close</button><button className="primary" disabled={saving} onClick={save}>{saving?'Saving…':plan.some(p=>p.done)?'Retry remaining changes':'Save schedule'}</button></footer></> :
    <form onSubmit={review}><div className="fields">
      <Select label="Event type" value={type} options={Object.entries(eventTypes).map(([value,label])=>({value,label}))} onChange={v=>{setType(v);setMeeting(meetingDefault(s.events.filter(e=>e.termId===term),v,meeting));}}/>
      <Field label="Events on or after" type="date" required value={from} onChange={e=>setFrom(e.target.value)}/>
      <Select label="New weekday" value={meeting.weekday} onChange={v=>setMeeting({...meeting,weekday:Number(v)})} options={['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((label,value)=>({label,value}))}/>
      <Field label={`Start time (${zoneLabel()})`} type="time" required value={`${String(meeting.hour).padStart(2,'0')}:${String(meeting.minute).padStart(2,'0')}`} onChange={e=>{const [hour,minute]=e.target.value.split(':').map(Number);setMeeting({...meeting,hour,minute});}}/>
      <Field label="Duration (minutes)" type="number" required min="1" max="720" value={meeting.durationMinutes} onChange={e=>setMeeting({...meeting,durationMinutes:Number(e.target.value)})}/>
      <p>{rows.length} events selected. Dates stay within their training week.</p>
      {error&&<p role="alert" className="error">{error}</p>}
    </div><footer className="actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={!rows.length}>Review schedule</button></footer></form>}
  </Drawer>;
}
