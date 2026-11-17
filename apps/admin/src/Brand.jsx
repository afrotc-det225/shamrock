import React from "react";
export default function Brand() {
  return (
    <div className="brand">
      <svg className="brand-mark" viewBox="0 0 40 44" aria-hidden="true">
        <path d="M20 24C14 17 11 13 12 8C13 1 23 0 27 5C31 11 25 18 20 24Z" />
        <path d="M20 24C12 28 7 30 3 26C-2 21 1 12 7 11C13 10 18 17 20 24Z" />
        <path d="M20 24C22 16 27 10 33 12C40 14 42 22 37 27C32 32 26 28 20 24Z" />
        <path className="brand-stem" d="M20 24C21 32 20 38 16 42" />
      </svg>
      <div>
        SHAMROCK<small>Detachment 225</small>
      </div>
    </div>
  );
}
