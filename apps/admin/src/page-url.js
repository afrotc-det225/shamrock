const pages = {
  leadership: {
    Overview:"overview", Cadets:"cadets", Leadership:"leadership", Events:"events",
    Attendance:"attendance", Excusals:"excusals", History:"history",
    "Semester planning":"semester", System:"system", Assistant:"assistant",
  },
  cadet: {Overview:"overview", Cadets:"cadets", Leadership:"leadership","My attendance":"attendance","Submit attendance":"submit-attendance","Attendance reviews":"attendance-reviews","My excusals":"requests", "My profile":"profile", "My Flight":"flight", Excusals:"excusals"},
};

export function pageHref(workspace, page, semester="latest") {
  if (workspace === "leadership" && page === "History") return "/attendance?semester="+encodeURIComponent(semester);
  const slug = pages[workspace][page];
  return workspace === "cadet" ? "/me/" + slug : "/" + slug;
}

const routes = new Map(Object.entries(pages).flatMap(([workspace, entries]) =>
  Object.entries(entries).map(([page,slug]) => [(workspace === "cadet" ? "/me/" : "/") + slug, {workspace,page}])));
routes.set("/me", {workspace:"cadet",page:null});

function pathRoute(pathname) {
  return routes.get(pathname.replace(/\/$/,""));
}

export function isWorkspacePath(pathname) {
  return !!pathRoute(pathname);
}

export function workspaceFromUrl(url = new URL(location.href)) {
  return pathRoute(url.pathname)?.workspace ?? (url.pathname === "/" ? url.searchParams.get("workspace") : null);
}

export function pageFromUrl(workspace, url = new URL(location.href)) {
  const route = pathRoute(url.pathname);
  if (workspace === "leadership" && route?.page === "Attendance" && url.searchParams.get("semester")) return "History";
  if (workspace === "cadet" && route?.page === "Overview") return "Overview";
  if (route) return route.workspace === workspace ? route.page : null;
  if (url.pathname !== "/" || workspaceFromUrl(url) !== workspace) return null;
  const slug = url.searchParams.get("page");
  return Object.keys(pages[workspace]).find(page => pages[workspace][page] === slug) ?? null;
}

export function writePageUrl(workspace, page, replace = false, semester = new URL(location.href).searchParams.get("semester") || "latest") {
  const href = pageHref(workspace, page, semester);
  if (location.pathname + location.search !== href)
    history[replace ? "replaceState" : "pushState"](null, "", href);
}

const returnKey = "shamrock-signin-page";
export function rememberSignInPage() {
  const workspace = workspaceFromUrl();
  if (!Object.hasOwn(pages,workspace)) return;
  const page = pageFromUrl(workspace);
  if (page) {
    try { sessionStorage.setItem(returnKey,JSON.stringify({workspace,page,semester:new URL(location.href).searchParams.get("semester"),time:Date.now()})); } catch {}
  }
}

export function restoreSignInPage() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(returnKey));
    sessionStorage.removeItem(returnKey);
    if (location.pathname !== "/" || location.search || !saved || Date.now()-saved.time > 600000) return;
    if (Object.hasOwn(pages,saved.workspace) && Object.hasOwn(pages[saved.workspace],saved.page))
      writePageUrl(saved.workspace,saved.page,true,saved.semester || "latest");
  } catch {}
}
