#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { planAttendanceRecovery } = require('./lib/attendance-recovery.cjs');
process.umask(0o077);

function privateIgnoredPath(file, existing) {
  const root = path.resolve(__dirname, '..');
  const absolute = path.resolve(file), parent = fs.realpathSync(path.dirname(absolute));
  if (parent !== path.dirname(absolute) || !absolute.startsWith(root + path.sep)) throw Error('PRIVATE_IGNORED_PATH_REQUIRED');
  const directory = fs.statSync(parent);
  if ((directory.mode & 0o077) || (process.getuid && directory.uid !== process.getuid())) throw Error('PRIVATE_DIRECTORY_REQUIRED');
  execFileSync('git', ['check-ignore', '-q', '--', absolute], {cwd:root,stdio:'ignore'});
  if (existing) {
    const info = fs.lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()) || info.size > 32 * 1024 * 1024) throw Error('PRIVATE_INPUT_REQUIRED');
  }
  return absolute;
}
function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Dry run only: node scripts/rehearse-attendance-recovery.cjs --input PRIVATE_IGNORED_JSON --output NEW_PRIVATE_IGNORED_JSON'); return;
  }
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') throw Error('INVALID_ARGUMENTS');
  const input = privateIgnoredPath(args[1], true), output = privateIgnoredPath(args[3], false);
  const fd = fs.openSync(input, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
  const report = planAttendanceRecovery(parsed);
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {mode:0o600,flag:'wx'});
  console.log(JSON.stringify({mode:report.mode,inputSha256:report.inputSha256,summary:report.summary,productionWrites:0}));
}
try { main(); } catch { console.error('Attendance recovery dry run failed. Check the private input, evidence and unused ignored output path. No production writes were attempted.'); process.exitCode=1; }
