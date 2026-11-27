// All Google access in this entry point is metadata GET only.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { prepareNativeCutover, verifyNativeContinuity } from './lib/native-cutover.mjs';
import { prepareNativeRows, verifyOriginalResponses, verifyFrozenSources } from './lib/native-cutover-rows.mjs';
import { prepareFirstPublication, verifyPublishedTables } from './lib/native-cutover-publication.mjs';
import { rehearseNativeCutover } from './lib/native-cutover-rehearsal.mjs';
import { prepareNativeDashboard, verifyAdoptedDashboard } from './lib/native-cutover-dashboard.mjs';

const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const saveNew = async (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
const formNames = { attendance: 'attendance', excusal: 'excusals', directory: 'directory' };

async function collect(manifest, reference, token) {
  const folder = { books: {}, forms: {} };
  const inventory = { production: structuredClone(folder), staging: structuredClone(folder) };
  const sheetFields =
    'spreadsheetId,spreadsheetUrl,properties(title,timeZone),sheets(properties(sheetId,title,hidden),tables(tableId,name,range,columnProperties),charts(chartId),filterViews(filterViewId,title))';
  async function get(kind, id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid Google resource identity');
    const url =
      kind === 'books'
        ? new URL('https://sheets.googleapis.com/v4/spreadsheets/' + id)
        : new URL('https://forms.googleapis.com/v1/forms/' + id);
    if (kind === 'books') url.searchParams.set('fields', sheetFields);
    const headers = { Authorization: 'Bearer ' + token };
    if (process.env.GOOGLE_CLOUD_QUOTA_PROJECT) headers['X-Goog-User-Project'] = process.env.GOOGLE_CLOUD_QUOTA_PROJECT;
    const response = await fetch(url, { headers, redirect: 'error' });
    if (!response.ok) throw new Error('Google metadata GET failed (' + response.status + ')');
    const result = await response.json();
    if ((kind === 'books' ? result.spreadsheetId : result.formId) !== id) throw new Error('Google returned a different resource');
    return result;
  }
  for (const entry of manifest.resources) {
    const kind = entry.kind === 'form' ? 'forms' : 'books';
    const key = kind === 'forms' ? formNames[entry.role] : entry.key;
    if (!key) throw new Error('Unknown original resource role');
    inventory.production[kind][key] = await get(kind, entry.providerId);
  }
  for (const [kind, keys] of Object.entries({ books: ['main', 'management'], forms: ['attendance', 'excusals', 'directory'] })) {
    for (const key of keys) inventory.staging[kind][key] = await get(kind, reference[kind][key]);
  }
  return inventory;
}

export async function run(args) {
  const [command, ...paths] = args;
  if (command === 'collect' && paths.length === 3) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const token = Buffer.concat(chunks).toString('utf8').trim();
    if (!token || /\s/.test(token)) throw new Error('Expected one short-lived Google access token on stdin');
    await saveNew(paths[2], await collect(await read(paths[0]), await read(paths[1]), token));
  } else if (command === 'prepare' && paths.length === 7) {
    const [manifest, inventory, capture, projection, operational, events] = await Promise.all(paths.slice(0, -1).map(read));
    const packet = prepareNativeCutover(inventory, manifest);
    verifyNativeContinuity(packet, inventory.production);
    packet.rows = prepareNativeRows(packet, { capture, projection, operational, events });
    packet.publication = prepareFirstPublication(packet, capture, projection);
    await saveNew(paths.at(-1), packet);
    console.log('Matched ' + packet.rows.marks + ' attendance cells and ' + packet.rows.percentages + ' percentages.');
  } else if (command === 'dashboard' && paths.length === 4) {
    const [packet, capture, reporting] = await Promise.all(paths.slice(0, -1).map(read));
    await saveNew(paths[3], prepareNativeDashboard(packet, capture, reporting));
  } else if (command === 'verify-dashboard' && paths.length === 2) {
    verifyAdoptedDashboard(...(await Promise.all(paths.map(read))));
    console.log('Original Dashboard links, source data, chart specs and positions matched.');
  } else if (command === 'rehearse' && paths.length === 3) {
    rehearseNativeCutover(...(await Promise.all(paths.map(read))));
    console.log('In-memory batch replay and Table, Form and response continuity checks passed.');
  } else if (command === 'verify-frozen' && paths.length === 3) {
    const [packet, inventory, capture] = await Promise.all(paths.map(read));
    verifyNativeContinuity(packet, inventory.production);
    verifyFrozenSources(packet, capture);
    console.log('Original source versions, data and Form revisions match the preparation packet.');
  } else if (command === 'verify-tables' && paths.length === 2) {
    const [packet, capture] = await Promise.all(paths.map(read));
    verifyPublishedTables(packet, capture);
    console.log('Adopted Table values matched at their original positions.');
  } else if (command === 'verify-responses' && paths.length === 2) {
    const [packet, capture] = await Promise.all(paths.map(read));
    verifyOriginalResponses(packet, capture);
    console.log('Every previously captured Form response matched.');
  } else if (['verify-original', 'verify-published'].includes(command) && paths.length === 2) {
    const [packet, inventory] = await Promise.all(paths.map(read));
    verifyNativeContinuity(packet, inventory.production, { published: command === 'verify-published' });
    console.log('Original Google identities and requested Form metadata checks passed.');
  } else
    throw new Error(
      'See D1_PRODUCTION_CUTOVER.md for collect, prepare, verify-original verify-published and verify-responses arguments.'
    );
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
