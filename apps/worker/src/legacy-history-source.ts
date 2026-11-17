/** Explicit source-layout mapping. Email in the predecessor's fourth column is never exposed. */
export function legacySourceLabelSql(index:number):string {
  if(!Number.isSafeInteger(index)||index<0||index>4)throw new Error('INVALID_HISTORY_LABEL');
  const column=[1,2,0,4,null][index],standard=`'$[${index}]'`,predecessor=column===null?null:`'$[${column}]'`;
  const cell=(path:string)=>`substr(CAST(COALESCE(json_extract(o.raw_json,${path}||'.effectiveValue.stringValue'),json_extract(o.raw_json,${path}||'.effectiveValue.numberValue'),json_extract(o.raw_json,${path}||'.userEnteredValue.stringValue'),json_extract(o.raw_json,${path}||'.userEnteredValue.numberValue'),'') AS TEXT),1,513)`;
  return `CASE WHEN json_extract(m.metadata_json,'$.sourceFormat')='predecessor-human-headers-v1' THEN ${predecessor===null?"''":cell(predecessor)} ELSE ${cell(standard)} END`;
}
