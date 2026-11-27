import React from "react";
import {SlidersHorizontal} from "lucide-react";
import {usePhone} from "./use-phone";
import {ToolbarPopover} from "./ToolbarPopover";

export function ToolbarFilters({active, children}) {
  const mobile = usePhone();
  if (!mobile) return children;
  return <ToolbarPopover label="Filters" icon={SlidersHorizontal} active={active}>
    <div className="filter-fields">{children}</div>
  </ToolbarPopover>;
}
