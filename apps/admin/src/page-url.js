const pages = {
  leadership: {
    Overview:"overview", Cadets:"cadets", Leadership:"leadership", Events:"events",
    Attendance:"attendance", Excusals:"excusals", History:"history",
    "Semester planning":"semester", System:"system", Assistant:"assistant",
  },
  cadet: {"My requests":"requests", "My profile":"profile", "My Flight":"flight", Excusals:"excusals"},
};

export function pageFromUrl(workspace, url = new URL(location.href)) {
  if (url.searchParams.get("workspace") !== workspace) return null;
  const slug = url.searchParams.get("page");
  return Object.keys(pages[workspace]).find(page => pages[workspace][page] === slug) ?? null;
}

export function pageHref(workspace, page) {
  return "/?" + new URLSearchParams({workspace, page:pages[workspace][page]});
}

export function writePageUrl(workspace, page, replace = false) {
  const href = pageHref(workspace, page);
  if (location.pathname + location.search !== href)
    history[replace ? "replaceState" : "pushState"](null, "", href);
}

const returnKey = "shamrock-signin-page";
export function rememberSignInPage() {
  const workspace = new URLSearchParams(location.search).get("workspace");
  if (!Object.hasOwn(pages,workspace)) return;
  const page = pageFromUrl(workspace);
  if (page) {
    try { sessionStorage.setItem(returnKey,JSON.stringify({workspace,page,time:Date.now()})); } catch {}
  }
}

export function restoreSignInPage() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(returnKey));
    sessionStorage.removeItem(returnKey);
    if (location.search || !saved || Date.now()-saved.time > 600000) return;
    if (Object.hasOwn(pages,saved.workspace) && Object.hasOwn(pages[saved.workspace],saved.page))
      writePageUrl(saved.workspace,saved.page,true);
  } catch {}
}
