/** Versioned operational CSV; text remains text until its schema explicitly converts it. */
export const CSV_VERSION = 'shamrock-operational-v1';
export const CSV_HEADERS = {
 directory:['person_id','expected_version','flight_id','last_name','first_name','as_year','rank','role','university','email','phone','dorm','cip_broad_area','cip_code','afsc','home_town','home_state','class_year','date_of_birth','flight_path_status','photo_link'],
 leadership:['contact_id','expected_version','person_id','last_name','first_name','rank','role','email','cell_phone','reports_to','office_phone','office_location','active'],
 events:['event_id','expected_version','term_id','event_type','training_week','display_order','label','column_label','expected_group','flight_ids_json','eligible_person_ids_json','status','start_at','end_at','location','notes'],
 attendance:['person_id','event_id','expected_base_version','expected_event_version','code','reason'],
 excusals:['request_id','expected_version','person_id','event_id','expected_event_version','requested_outcome','request_reason','status','decision_reason'],
 data_legend:['list','position','value'],
};
export function category(value){const result=value==='cadre'?'leadership':value;if(!Object.hasOwn(CSV_HEADERS,result))throw Error('CSV_CATEGORY');return result;}
export function parseCsv(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>64*1024*1024)throw Error('CSV_SIZE');
 if(text.charCodeAt(0)===0xfeff)text=text.slice(1);
 const rows=[];let row=[],cell='',quoted=false,closed=false,started=false;
 const addCell=()=>{if(cell.length>100000)throw Error('CSV_CELL_SIZE');row.push(cell);cell='';closed=false;started=false;};
 const addRow=()=>{addCell();if(rows.length>=25001||row.length>100)throw Error('CSV_SIZE');rows.push(row);row=[];};
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
  if(c===','){addCell();continue;}
  if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;addRow();continue;}
  if(closed)throw Error('CSV_AFTER_QUOTE');
  if(c==='"'){if(started)throw Error('CSV_QUOTE');quoted=true;started=true;}else{cell+=c;started=true;}
 }
 if(quoted)throw Error('CSV_UNCLOSED_QUOTE');
 if(started||closed||cell||row.length)addRow();
 return rows;
}
export function encodeCsv(rows){
 const cell=v=>{const value=v===null||v===undefined?'':String(v);return /[",\r\n]/.test(value)?`"${value.replaceAll('"','""')}"`:value;};
 return rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
export function readOperationalCsv(text,kind){
 kind=category(kind);const rows=parseCsv(text),headers=['schema_version',...CSV_HEADERS[kind]];
 if(!rows.length||JSON.stringify(rows[0])!==JSON.stringify(headers))throw Error('CSV_HEADERS');
 return rows.slice(1).map((cells,index)=>{if(cells.length!==headers.length||cells[0]!==CSV_VERSION)throw Error(`CSV_ROW_SCHEMA:${index+2}`);return Object.fromEntries(CSV_HEADERS[kind].map((key,i)=>[key,cells[i+1]]));});
}
export function writeOperationalCsv(kind,rows){kind=category(kind);return encodeCsv([['schema_version',...CSV_HEADERS[kind]],...rows.map(row=>[CSV_VERSION,...CSV_HEADERS[kind].map(key=>row[key]??'')])]);}
