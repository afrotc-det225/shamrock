# Isolated Google adapter prototype

This module is part of the local/staging D1 experiment. It does not replace the current Apps Script runtime, install triggers, open production files, send email or deploy itself. The root v3 build bundles `src/apps-script.ts` as `SHAMROCKV3` for Apps Script V8; its ES-module source remains independently testable in Node.

Implemented boundaries:

- Native Form response and item identities, enrolled verified responder lookup, immutable `[sr:reference]` person/event/scope choices, and explicit partial/complete attendance reports. Old choice references retain their exact roster snapshot; label text is not identity. Repeated native delivery produces the same command ID.
- Single-cell decision drafts with stable slot/request identity and base version. `e.user` evidence is read when Google supplies it; no effective-user substitution occurs. Missing/unmapped identity leaves a confirmation-required draft. Multi-cell paste requires an explicit frozen review workflow.
- Signed commands matching the Worker's raw-body SHA-256/HMAC protocol. The Google host uses `Utilities`, with negative-byte encoding normalized correctly. Signed HTTP requests do not follow redirects.
- A bounded private Sheets journal, addressed by headers and serialized under a script lock. Enqueue before delivery; retry the exact payload/ID with a fresh signature. Timeouts and ambiguous responses stay pending; conflicts/rejections/authorization failures remain visible for intervention. Capacity exhaustion never deletes unsent input. The prototype retains terminal rows until an operator archives them under an approved retention procedure.
- Recorded-decision publication writes only output cells, checks stable target identity and current recorded version, and leaves draft values/base versions untouched. Job request signing supports claim/project/ack; lease management remains the Worker's responsibility.

## Required isolated host wiring

Supply a dedicated standalone script with a configured staging Worker origin, environment/generation and signing key from Script Properties; never place the signing key in a spreadsheet-bound launcher. The injected signer keeps its key in a closure. Configure logical source bindings and enrolled principals rather than trusting respondent-supplied IDs or email questions.

Create a private journal workbook with only trusted script maintainers as editors. `enqueueGoogleCommand` and `flushGoogleCommands` operate on the explicitly supplied sheet and ScriptLock. The journal starts with seven machine headers; their physical order can change. Default bounds are 1,000 retained commands, 1,000,000 payload characters total and 45,000 per payload. Oversized inputs need a reviewed chunking workflow; never silently truncate them. The script lock is held through the small dispatch batch, serializing participating adapter executions, not human edits.

An actual Form trigger must bind `e.source` to the configured Form, verify its collected-email mode and applicable sharing policy, read the native `FormResponse`, and resolve the respondent through the enrolled identity registry. `snapshotGoogleForm` accepts a verified-settings flag from trusted configuration; it does **not** prove the flag or respondent policy itself. The decision trigger must freeze `e.value` and stable protected slot identity, persist/retain the draft, and use `e.user` when present. A separate authenticated confirmation flow remains to be built; an unknown actor cannot be upgraded by supplying a text email.

Keep decision draft rows in stable protected slots or a dedicated keyed input table. Never sort/rebind their neighboring identity while input is pending. Serialize output publishers per resource and write only recorded-result columns. A script lock cannot stop a person changing cells; input/output separation and protected immutable targets are essential. Complete Google Tables/filter/format rendering is still future work.

The current core provides signed job requests but does not automatically claim/publish/ack a live Google job. A future host must load the current D1 projection, publish and read it back, then acknowledge the current claim. If Google publication is uncertain or the lease expires, retain the job for review instead of assuming a new lease can cancel the old API request. API writes do not fire downstream user-edit triggers; orchestration must schedule its own dependent work.

## Validation boundary

`tests/v3/google-adapter.test.mjs` covers source mapping, duplicate names, delayed catalog responses, zero-attendee completeness, native identity, Apps Script HMAC encoding, redirect handling, journal retry/capacity/integrity, unknown editors, bulk-review rejection and pending-draft preservation. These are local injected-port tests, not proof of live Google behavior. Real Form settings, cross-domain actor visibility, physical Sheet protections/sorting, OAuth and publication must pass an isolated institutional-account rehearsal before integration with production.
