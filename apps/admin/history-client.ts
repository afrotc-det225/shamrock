import { assembleLegacyHistoryPages } from "../../packages/domain/src/legacy-history-transport";

/** Fetch one immutable archive in bounded requests; never display a partial capture. */
export async function loadHistory(snapshotId, request, progress = (_count, _total) => {}) {
  let bytes = 0, calls = 0, viewRevision;
  async function page(section, offset, sourceSnapshotSha256) {
    if (++calls > 520) throw new Error("This report exceeds the supported size.");
    const value = await request("/history/page", { snapshotId, section, offset, sourceSnapshotSha256, ...(viewRevision ? {viewRevision} : {}) });
    bytes += new TextEncoder().encode(JSON.stringify(value)).length;
    if (bytes > 32 * 1024 * 1024) throw new Error("This report exceeds the supported size.");
    return value;
  }
  const manifest = await page("manifest", 0, null), pages = [];
  viewRevision = manifest.viewRevision;
  if (manifest.snapshotId !== snapshotId || manifest.rowCount > 500 || manifest.rosterCount > 500)
    throw new Error("The report could not be verified.");
  for (const section of ["roster", "rows"]) {
    let offset = 0;
    do {
      const value = await page(section, offset, manifest.sourceSnapshotSha256);
      if (value.section !== section || value.offset !== offset || !Array.isArray(value.rows) ||
          (value.nextOffset !== null && value.nextOffset !== offset + value.rows.length) ||
          (value.nextOffset !== null && value.nextOffset <= offset))
        throw new Error("The report changed while loading. Please retry.");
      pages.push(value);
      if (section === "rows") progress(offset + value.rows.length, manifest.rowCount);
      offset = value.nextOffset;
    } while (offset !== null);
  }
  const verified = await page("verify", 0, manifest.sourceSnapshotSha256);
  return assembleLegacyHistoryPages(manifest, pages, verified);
}
