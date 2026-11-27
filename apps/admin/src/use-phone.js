import {useSyncExternalStore} from "react";

const query = "(max-width: 640px)";
function subscribe(notify) {
  const media = matchMedia(query);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}
export function usePhone() {
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches, () => false);
}
