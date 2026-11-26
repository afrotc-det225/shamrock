const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Actual trigger -> handler -> log/audit -> batch mirror, with in-memory Google IO.
const root = process.env.SHAMROCK_TEST_SOURCE_ROOT || path.join(__dirname, '..');
const files = ['utils/arrays.ts', 'config/schemas.ts', 'services/attendance.ts', 'services/audit.ts', 'services/frontend-edit.ts', 'index.ts'];
const compiled = files.map(file => {
  const source = fs.readFileSync(path.join(root, 'src', file), 'utf8')
    .replace('  function buildMatrixRows(', '  export function buildMatrixRows(');
  return [file, ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2019,module:ts.ModuleKind.None}}).outputText];
});
const clone = value => JSON.parse(JSON.stringify(value));
const fixed = ['last_name','first_name','as_year','flight','squadron','overall_attendance_pct','llab_attendance_pct'];
const logHeaders = ['submission_id','submitted_at','event','attendance_type','email','name','flight','cadets'];
const eventHeaders = ['event_id','display_name','attendance_column_label','event_type','status'];
const roster = [['North','One'],['South','Two'],['West','Three']];
function letter(n) { let result=''; for(;n;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result; return result; }
function fixture(options = {}) {
  const calls = {reads:[],tableReads:[],insertions:[],writes:[],batches:[],messages:[],lock:[],flush:0};
  const state = {held:false,uuid:0,failLog:false,failMirror:false,failAudit:false,afterLog:false,afterMirror:false,onWait:null,onMirror:null};
  const sheets = new Map();
  function sheet(name, headers, rows, id = 'backend') {
    const cells = [headers.slice(),headers.slice(),...rows.map(row=>row.slice())];
    let maxRows=1000;
    const result = {cells,getMaxRows:()=>maxRows,insertRowsAfter(after,count){assert.equal(after,maxRows);calls.insertions.push({name,count});maxRows+=count;},getName:()=>name,getParent:()=>({getId:()=>id}),getLastRow:()=>cells.length,
      getLastColumn:()=>Math.max(...cells.map(row=>row.length)),
      getRange(row,col,height=1,width=1) {
        return {getSheet:()=>result,getRow:()=>row,getColumn:()=>col,getLastRow:()=>row+height-1,getLastColumn:()=>col+width-1,
          getNumRows:()=>height,getNumColumns:()=>width,getA1Notation:()=>`${letter(col)}${row}${height>1||width>1?`:${letter(col+width-1)}${row+height-1}`:''}`,
          getValue:()=>cells[row-1]?.[col-1]??'',
          getValues(){calls.reads.push({name,row,col,height,width});return Array.from({length:height},(_,i)=>Array.from({length:width},(_,j)=>cells[row+i-1]?.[col+j-1]??''));},
          setValues(values) {
            if(row+values.length-1>maxRows)throw Error('Write exceeds sheet grid.');
            calls.writes.push({name,row,col,values:clone(values)});
            if(name==='Audit Backend'&&state.failAudit)throw Error('Audit write failed.');
            if(name==='Attendance Backend'&&state.failLog)throw Error('Attendance log write failed.');
            values.forEach((value,i)=>value.forEach((cell,j)=>{cells[row+i-1]??=[];cells[row+i-1][col+j-1]=cell;}));
            if(name==='Attendance Backend'&&state.afterLog)throw Error('Attendance log response lost.');
          },
        };
      },
    };
    sheets.set(`${id}/${name}`,result);return result;
  }
  const headers=[...fixed,'Event A','Event B'];
  const front=sheet('Attendance',headers,roster.map(([last,first])=>[last,first,'AS400','Alpha','Blue','','','A','U']),'frontend');
  const back=sheet('Attendance Matrix Backend',headers,[...roster].reverse().map(([last,first])=>[last,first,'AS400','Alpha','Blue','','','A','U']));
  const log=sheet('Attendance Backend',logHeaders,[]);
  const events=sheet('Events Backend',eventHeaders,[['event.a','Event A','Label A','llab',''],['event.b','Event B','Label B','secondary','']]);
  let audit;
  const readTable=s=>({headers:s.cells[0].slice(),rows:s.cells.slice(2).map(row=>Object.fromEntries(s.cells[0].map((h,i)=>[h,row[i]??''])))});
  const lock={hasLock:()=>state.held,waitLock(ms){calls.lock.push(['wait',ms]);state.onWait?.();state.held=true;},releaseLock(){calls.lock.push(['release']);state.held=false;}};
  const context=vm.createContext({console,Date,Map,Set,Error,JSON,
    Log:{info:message=>calls.messages.push(message),warn:message=>calls.messages.push(message),error:message=>calls.messages.push(message)},
    Config:{getBackendId:()=> 'backend',getFrontendId:()=> 'frontend',getBackendSheet:name=>sheets.get(`backend/${name}`),PROPERTY_KEYS:{}},
    PauseService:{isPaused:()=>false},
    Session:{getActiveUser:()=>({getEmail:()=> 'editor@example.test'}),getTemporaryActiveUserKey:()=> 'actor-key'},
    Utilities:{getUuid:()=>`fixture-${++state.uuid}`},
    LockService:{getScriptLock:()=>lock},
    SpreadsheetApp:{flush:()=>{calls.flush++;},getActiveSpreadsheet:()=>null},
    SheetUtils:{getSheet:(id,name)=>sheets.get(`${id}/${name}`),readTable:s=>{calls.tableReads.push(s.getName());return readTable(s);},ensureSchemaColumns:s=>s.cells[0].slice(),
      appendRows(s,rows){s.getRange(Math.max(3,s.getLastRow()+1),1,rows.length,s.getLastColumn()).setValues(rows.map(row=>s.cells[0].map(h=>row[h]??'')));}},
    Sheets:{Spreadsheets:{Values:{batchUpdate(request,id){
      calls.batches.push(clone(request));state.onMirror?.();
      if(state.failMirror)throw Error('Mirror interrupted.');
      assert.equal(id,'backend');assert.equal(request.valueInputOption,'RAW');
      request.data.forEach(({range,values})=>{
        const match=/^'Attendance Matrix Backend'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);assert(match,range);
        const column=[...match[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
        values.forEach((row,i)=>{back.cells[Number(match[2])-1+i][column-1]=row[0];});
      });
      if(state.afterMirror)throw Error('Mirror response lost.');
    }}}},
  });
  for (const [file,code] of compiled)vm.runInContext(code,context,{filename:file});
  audit=sheet('Audit Backend',Array.from(context.Schemas.BACKEND_TABS.find(s=>s.name==='Audit Backend').machineHeaders),[]);
  const edit=(r,c,h=1,w=1,value,oldValue)=>{
    const event={range:front.getRange(r,c,h,w)};
    if(value!==undefined)event.value=value;if(oldValue!==undefined)event.oldValue=oldValue;
    context.onFrontendEdit(event);
  };
  const records=()=>readTable(log).rows;
  const audits=()=>readTable(audit).rows;
  return {front,back,log,events,calls,state,context,edit,records,audits,readTable};
}

test('real trigger persists every row in a bulk edit, one append and one sparse backend mirror',()=>{
  const f=fixture();f.front.cells.slice(2).forEach(row=>row[7]='P');
  f.edit(3,8,3,1);
  assert.equal(f.records().length,3);assert.deepEqual(f.records().map(r=>r.cadets),['North, One','South, Two','West, Three']);
  assert(f.records().every(r=>r.event==='Event A'&&r.attendance_type==='P'&&r.name==='Admin'));
  assert.equal(f.calls.writes.filter(w=>w.name==='Attendance Backend').length,1);
  assert.equal(f.calls.writes.filter(w=>w.name==='Audit Backend').length,1);
  assert.equal(f.calls.batches.length,1);assert.equal(f.calls.batches[0].data.length,1);
  assert(f.back.cells.slice(2).every(row=>row[7]==='P'&&row[8]==='U'));
  assert.deepEqual(f.audits().map(row=>row.target_range),['Attendance!H3','Attendance!H4','Attendance!H5']);
  assert(f.audits().every(row=>row.result==='ok'&&JSON.parse(row.metadata_json).oldValueKnown===false));
  assert.equal(f.calls.writes.filter(w=>w.name==='Attendance').length,0);
  assert.deepEqual(f.calls.lock,[['wait',120000],['release']]);
  assert(!f.calls.messages.some(message=>/North|South|West|editor@example/.test(message)));
});

test('multiple event columns and mixed codes including explicit bulk clears survive ordered replay',()=>{
  const f=fixture();f.front.cells[2][7]='P';f.front.cells[2][8]='';f.front.cells[3][7]='E';f.front.cells[3][8]='T';
  f.edit(3,8,2,2);
  assert.deepEqual(f.records().map(row=>[row.event,row.cadets,row.attendance_type]),[
    ['Event A','North, One','P'],['Event B','North, One',''],['Event A','South, Two','E'],['Event B','South, Two','T']]);
  assert.equal(f.calls.batches.length,1);assert.equal(f.calls.batches[0].data.length,2);
  const replay=f.context.AttendanceService.buildMatrixRows(roster.map(([last_name,first_name])=>({last_name,first_name})),[{name:'Event A'},{name:'Event B'}],f.records());
  assert.equal(replay[0]['Event B'],'');assert.equal(replay[1]['Event B'],'T');
  assert.deepEqual(f.back.cells.slice(2).map(row=>row.slice(7)),[['A','U'],['E','T'],['P','']]);
});

test('clips fixed columns and both header rows, and ignores edits wholly outside data cells',()=>{
  const f=fixture();f.front.cells[2][7]='P';f.front.cells[3][7]='T';
  f.edit(1,6,4,3);
  assert.deepEqual(f.records().map(row=>row.attendance_type),['P','T']);
  assert(f.records().every(row=>row.event==='Event A'));
  const count=f.records().length;f.edit(1,1,2,9);f.edit(3,1,3,7);
  assert.equal(f.records().length,count);
});

test('single cell preserves old/new audit values and explicit blank, with no invented P',()=>{
  const f=fixture();f.front.cells[2][7]='T';f.edit(3,8,1,1,'T','A');
  assert.equal(f.records()[0].attendance_type,'T');assert.equal(f.audits()[0].old_value,'A');assert.equal(f.audits()[0].new_value,'T');
  f.front.cells[2][7]='';f.edit(3,8,1,1,undefined,'T');
  assert.equal(f.records()[1].attendance_type,'');assert.equal(f.audits()[1].old_value,'T');
  f.edit(3,8,1,1,undefined,'');assert.equal(f.records().length,2);
});

test('current unique event alias is canonicalized for future matrix rebuild',()=>{
  const f=fixture();f.front.cells[0][7]='event.a';f.front.cells[2][7]='P';
  f.edit(3,8,1,1,'P','A');
  assert.equal(f.records()[0].event,'Event A');assert.equal(f.back.cells[4][7],'P');
});

test('stale, canceled and ambiguous event columns reject the whole edit before persistence',()=>{
  for(const alter of [f=>f.events.cells.splice(3,1),f=>f.events.cells[3][4]='cancelled',f=>f.events.cells[3][2]='Event A',f=>f.front.cells[0][8]='Event A']) {
    const f=fixture();alter(f);f.front.cells[2][7]='P';f.front.cells[2][8]='P';assert.throws(()=>f.edit(3,8,1,2));
    assert.equal(f.records().length,0);assert.equal(f.calls.batches.length,0);assert.equal(f.audits().at(-1).result,'failed');
  }
});

test('sorted frontend/backend targets resolve independently and unrelated pending edits are untouched',()=>{
  const f=fixture();[f.front.cells[2],f.front.cells[4]]=[f.front.cells[4],f.front.cells[2]];
  f.front.cells[2][7]='T';f.front.cells[4][7]='E';f.edit(3,8,1,1,'T','A');
  assert.equal(f.records()[0].cadets,'West, Three');assert.equal(f.back.cells[2][7],'T');
  assert.equal(f.front.cells[4][7],'E');assert.equal(f.back.cells[4][7],'A');
});

test('ambiguous or absent cadet identities reject without an append or a guessed target',()=>{
  for(const alter of [f=>f.front.cells[3][0]='',f=>{f.front.cells[3][0]='North';f.front.cells[3][1]='One';},f=>{f.back.cells[4][0]='Unknown';}]) {
    const f=fixture();alter(f);f.front.cells[2][7]='P';f.front.cells[3][7]='P';assert.throws(()=>f.edit(3,8,2,1));
    assert.equal(f.records().length,0);assert.equal(f.calls.batches.length,0);
  }
});

test('a newer value or changed layout during lock wait rejects a delayed edit',()=>{
  for(const alter of [f=>f.front.cells[2][7]='E',f=>f.front.cells[0][7]='Event B',f=>{[f.front.cells[2],f.front.cells[3]]=[f.front.cells[3],f.front.cells[2]];}]) {
    const f=fixture();f.front.cells[2][7]='P';f.state.onWait=()=>alter(f);assert.throws(()=>f.edit(3,8,1,1,'P','A'));
    assert.equal(f.records().length,0);assert.equal(f.calls.batches.length,0);assert.equal(f.state.held,false);
  }
  const f=fixture();f.front.cells[2][7]='E';assert.throws(()=>f.edit(3,8,1,1,'P','A'));assert.equal(f.records().length,0);
});

test('failed append cannot produce a success audit or any derived mirror',()=>{
  const f=fixture();f.front.cells[2][7]='P';f.state.failLog=true;assert.throws(()=>f.edit(3,8,1,1,'P','A'));
  assert.equal(f.records().length,0);assert.equal(f.calls.batches.length,0);assert(f.audits().every(row=>row.result==='failed'));assert.equal(f.state.held,false);
});

test('interrupted mirror retains the complete durable batch and rebuild can replay it',()=>{
  const f=fixture();f.front.cells.slice(2).forEach(row=>row[7]='P');f.state.failMirror=true;
  f.state.onMirror=()=>assert.equal(f.records().length,3,'all corrections exist before any mirror call');assert.throws(()=>f.edit(3,8,3,1));
  assert.equal(f.records().length,3);assert(f.audits().every(row=>row.result==='failed'));
  const replay=f.context.AttendanceService.buildMatrixRows(roster.map(([last_name,first_name])=>({last_name,first_name})),[{name:'Event A'}],f.records());
  assert(replay.every(row=>row['Event A']==='P'));assert.equal(f.state.held,false);
});

test('lost append response is not retried or falsely reported as successful',()=>{
  const f=fixture();f.front.cells[2][7]='P';f.state.afterLog=true;assert.throws(()=>f.edit(3,8,1,1,'P','A'));
  assert.equal(f.records().length,1);assert.equal(f.calls.writes.filter(w=>w.name==='Attendance Backend').length,1);
  assert.equal(f.calls.batches.length,0);assert(f.audits().every(row=>row.result==='failed'));
  assert.equal(f.records()[0].submission_id, `manual-${f.audits()[0].run_id}-3-8`, 'failed operation still identifies its persisted log batch');
});


test('audit failure is visible after durable persistence and does not retry the attendance append',()=>{
  const f=fixture();f.front.cells[2][7]='P';f.state.failAudit=true;
  assert.throws(()=>f.edit(3,8,1,1,'P','A'),/audit batch was not confirmed/);
  assert.equal(f.records().length,1);assert.equal(f.back.cells[4][7],'P');
  assert.equal(f.calls.writes.filter(w=>w.name==='Attendance Backend').length,1);
  assert(!f.calls.messages.some(message=>/Saved 1 manual/.test(message)));
});

test('lost mirror response keeps durable corrections and reports unconfirmed projection without another write',()=>{
  const f=fixture();f.front.cells[2][7]='P';f.state.afterMirror=true;
  assert.throws(()=>f.edit(3,8,1,1,'P','A'),/derived backend mirror did not finish/);
  assert.equal(f.records().length,1);assert.equal(f.back.cells[4][7],'P');assert.equal(f.calls.batches.length,1);
  assert(f.audits().every(row=>row.result==='failed'));
});

test('large rectangular edit performs one event read, one matrix read, one log append and one sparse mirror request',()=>{
  const f=fixture();f.front.cells.splice(2);f.back.cells.splice(2);
  for(let n=0;n<100;n++) {
    f.front.cells.push(['Cadet',`Example${n}`,'AS400','Alpha','Blue','','','P','']);
    f.back.cells.push(['Cadet',`Example${99-n}`,'AS400','Alpha','Blue','','','A','U']);
  }
  f.edit(3,8,100,2);
  assert.equal(f.records().length,200);assert.deepEqual(f.calls.tableReads,['Events Backend','Attendance Matrix Backend']);
  assert.equal(f.calls.writes.filter(w=>w.name==='Attendance Backend').length,1);
  assert.equal(f.calls.writes.filter(w=>w.name==='Audit Backend').length,1);
  assert.equal(f.calls.batches.length,1);assert.equal(f.calls.batches[0].data.length,2);
});


test('an unsupported value or literal formula rejects the entire paste before any durable write',()=>{
  for(const value of ['Invalid','=1+1','p','FALSE']) {
    const f=fixture();f.front.cells[2][7]='P';f.front.cells[3][7]=value;
    assert.throws(()=>f.edit(3,8,2,1),/unsupported code/);
    assert.equal(f.records().length,0);assert.equal(f.calls.batches.length,0);
    assert(f.audits().every(row=>row.result==='failed'));
  }
});

test('event names cannot target fixed backend identity columns',()=>{
  const f=fixture();f.events.cells[2][1]='last_name';f.front.cells[0][7]='event.a';f.front.cells[2][7]='P';
  assert.throws(()=>f.edit(3,8,1,1,'P','A'),/event column is missing or ambiguous/);
  assert.equal(f.records().length,0);assert.equal(f.back.cells[4][0],'North');
});


test('an alias reused by a canceled and current event is rejected instead of retargeted',()=>{
  const f=fixture();f.events.cells[2][4]='cancelled';f.events.cells[3][2]='event.a';
  f.front.cells[0][7]='event.a';f.front.cells[2][7]='P';
  assert.throws(()=>f.edit(3,8,1,1,'P','A'),/stale or ambiguous event header/);
  assert.equal(f.records().length,0);assert.equal(f.calls.batches.length,0);
});

test('large durable log and audit batches extend sheet grids once before append',()=>{
  const f=fixture();f.front.cells.splice(2);f.back.cells.splice(2);
  for(let n=0;n<600;n++) {
    f.front.cells.push(['Cadet',`Example${n}`,'AS400','Alpha','Blue','','','P','']);
    f.back.cells.push(['Cadet',`Example${599-n}`,'AS400','Alpha','Blue','','','A','U']);
  }
  f.edit(3,8,600,2);
  assert.equal(f.records().length,1200);assert.equal(f.audits().length,1200);
  assert.deepEqual(f.calls.insertions,[{name:'Attendance Backend',count:202},{name:'Audit Backend',count:202}]);
});
