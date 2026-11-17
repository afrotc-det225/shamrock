# Retained source history in the Dashboard

The Dashboard can compare the current operational term with the two newest
reviewed prior terms, including retained source reports that predate D1. This
is an optional extension to the bounded native-term comparison reader. It
neither imports historical rows into today's roster nor changes any saved
Attendance cell, percentage, source formula or source report.

## Explicit source review

Choose one exact source snapshot for each retained term. Read its complete
History report and compare saved percentages and captured AS-year labels before
configuring it. A repeated period title does not identify a canonical copy.
Reports with the same saved percentages can still have different formulas or
attendance codes; keep all source copies intact in History. An unnamed archive
is not assigned a semester automatically. Current captures cannot be selected
as prior-term summaries.

The private native frontend configuration may supply
`supplemental.dashboard.reviewedRetainedHistory` with this shape:

```json
{
  "version": 1,
  "reviewId": "reviewed-historical-comparison",
  "selectionSha256": "SHA256_OF_CANONICAL_REVIEW_BODY",
  "terms": [
    {
      "termId": "retained-prior-term",
      "label": "Prior semester",
      "sortOrder": 1,
      "snapshotId": "PRIVATE_RETAINED_SNAPSHOT_ID",
      "sourceSnapshotSha256": "EXACT_COMPLETED_IMPORT_DIGEST",
      "expectedPeriodLabel": "EXACT_SAVED_PERIOD_LABEL"
    }
  ]
}
```

At most two selections are allowed. The term ID, display label and sort order
must be unique and must not conflict with a native prior term. Sort order uses
the same ordering as the native term catalog and must precede the current term.
The saved period label and import digest must match D1 exactly. Operational
identifiers and actual digests stay in the private configuration, not Git.

`parseReviewedRetainedHistory(value)` checks the structure. For the exact digest,
construct `{version: 1, reviewId, terms}` and calculate SHA-256 of
`retainedHistoryCanonical(body)`; the canonicalizer sorts object keys and
preserves the reviewed term-array order. The paged transport calls the same
parser with the configured signer's SHA-256 function before using the selection.
Changing a source, label, order or review ID requires a new digest and review.

The native runtime must validate the optional field and pass it as the fifth
argument to `createPagedFrontendTransport`. This module is not an automatic
provider configuration migration. Deploy the Worker endpoint and adapter
integration, add the reviewed private selection, and verify a full staging
publication before accepting the feature. No production cutover is implied.

## Bounded aggregate reader

`POST /v1/admin/history/summary` uses the existing signed bridge and requires a
currently active Wing `frontend.read` principal. Its exact request is:

```text
{environment, generation, principalId,
 selections: [{snapshotId, sourceSnapshotSha256, expectedPeriodLabel}]}
```

A single D1 batch evaluates authority and reads one metadata/aggregate pair per
selection: three statements for one source or five for two. Each source scan is
bounded to 501 rows, with 500 accepted; larger reports fail. SQL returns at most
12 bins per source (the 11 canonical AS categories plus unknown), with a total
response ceiling of 16 KB. Full event arrays, source formulas, names, emails,
phones, person IDs, provider identifiers and raw occurrence payloads are never
returned by this endpoint. No schema migration, database write, job, notification,
cache or paid service is introduced.

The mean uses **saved numeric percentages only**, including zero. Text, booleans
and null values are omitted and counted explicitly; they are not coerced into
percentages. Out-of-range numeric values, missing fields, mismatched captured
AS-year evidence, missing source rows, changed digests/period labels, current
captures or incomplete imports fail before a Dashboard can be planned. The
source row's captured AS-year label determines its historical category. Today's
AS year, Flight assignment and resolved identity are not consulted. Unresolved
rows still contribute their saved percentages. Unknown AS-year rows contribute
to the overall mean and are counted separately from named category series.

The result carries row, unresolved-row and unknown-year counts plus numeric
contributor/omission counts for Overall and LLAB, both for the complete source
and each known year. The Dashboard comparison uses saved Overall percentages;
LLAB evidence remains available without inventing a new chart. These aggregate
counts are evidence about retained rows, not a count of unique historical people.
The admin server must apply its `fullSnapshot` gate to this broad history route
just as it does to the other `/history/*` routes.

## Publication and continuity

For a `frontend.refresh`, the transport combines the reviewed retained-term
catalog with the bounded native prior-term catalog, then reads only the newest
two comparisons. One compact request supplies all selected retained summaries.
Native prior terms still use their frozen roster/fact readers. As new native
semesters are created, they displace older retained terms by explicit sort order;
no old source copy is rewritten or deleted.

Before returning the snapshot to the publisher, the transport verifies the
original operational revision and effect lease again. A source mismatch,
failed read, malformed count, duplicate term or lost final verification returns
no partial snapshot. The retained configuration is used on every refresh, so a
later successful publication does not erase history by falling back to a
current-only snapshot. Forms and ordinary current snapshot reads do not issue
the extra historical request.

`buildCoherentFrontendReporting` keeps the current Attendance matrix separate.
It adds selected historical percentages to `dashboard.termTrend` and
`dashboard.attendanceByYear`, and exposes exact source/count evidence in
`dashboard.retainedHistory` for source notes and operator review. Unresolved
identities are not silently reported as resolved. Source History sheets continue
to show every original row independently.

## Validation and release boundary

Local tests cover signed routing, current Wing permission/revocation, source
binding, incomplete imports, unknown years, saved zero/text/boolean/null
semantics, source mismatch, repeated publication, native-term displacement,
selection digest changes and final effect-lease drift. The SQL reader was also
run read-only against all six retained real-data reports (510 rows and six
unresolved rows); whole-source and AS-year saved means agreed within
`2.23e-16` floating-point rounding and the source database hash was unchanged.
The local SQL bins were 808–1,063 bytes per source. These results establish
saved-value parity, not hosted Worker CPU or provider spreadsheet rendering.

Before release acceptance, verify the selected source IDs/digests privately,
measure the deployed endpoint with its actual two-source response, and read back
the next complete native Dashboard publication. Confirm current plus two prior
term labels/series and honest unresolved/omitted count notes. Keep staging
paused between rehearsals and leave the operational production system unchanged.
