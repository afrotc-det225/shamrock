import React, {useId, useLayoutEffect, useRef} from "react";
import {profileChoices} from "../../../packages/domain/src/profile-choices";
import {profileFieldIssue} from "../../../packages/domain/src/profile-fields";
import {Field} from "./components";

export function ProfileField({field, label, value, original, broadArea, originalBroadArea, required, onChange}) {
  const id = useId();
  const input = useRef(null);
  const choices = profileChoices[field];
  const issue = value === original && broadArea === originalBroadArea ? "" : profileFieldIssue(field,value,broadArea);
  useLayoutEffect(() => { input.current.setCustomValidity(issue); }, [issue]);
  const type = ({phone:"tel", cellPhone:"tel", officePhone:"tel", email:"email", dateOfBirth:"date", photoLink:"url"})[field] || "text";
  return <Field label={label}>
    <input ref={input} name={field} aria-label={label} type={type} required={required} list={choices ? id : undefined}
      value={value ?? ""} maxLength={field === "photoLink" ? 2048 : field === "classYear" ? 4 : field === "email" ? 254 : 240}
      inputMode={field === "classYear" ? "numeric" : undefined}
      placeholder={choices ? "Type to find an option" : field === "cipCode" ? "00.0000" : undefined}
      onChange={e => onChange(e.target.value)}
      onBlur={choices ? e => {
        const match = choices.find(option => option.toLowerCase() === e.target.value.trim().toLowerCase());
        if (match && match !== value) onChange(match);
      } : undefined}/>
    {choices && <datalist id={id}>{choices.map(option => <option key={option} value={option}/>)}</datalist>}
  </Field>;
}
