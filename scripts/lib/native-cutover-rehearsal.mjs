// Replay the exact candidate batches on private in-memory copies. This exercises
// address translation and readback invariants, not provider permissions or API acceptance.
import { importDigest } from './import-capture.mjs';
import { verifyNativeContinuity } from './native-cutover.mjs';
import { verifyOriginalResponses } from './native-cutover-rows.mjs';
import { verifyPublishedTables } from './native-cutover-publication.mjs';

export function rehearseNativeCutover(packet, inventory, original) {
  verifyNativeContinuity(packet, inventory.production);
  if (original.snapshotSha256 !== packet.rows.snapshotSha256) throw new Error('Packet and rehearsal capture differ');
  const after = structuredClone(original),
    production = structuredClone(inventory.production);
  for (const [key, plan] of Object.entries(packet.forms)) {
    const form = production.forms[key];
    if (form.revisionId !== plan.batch.writeControl.requiredRevisionId) throw new Error('Stale Form revision');
    for (const { createItem, updateItem, updateSettings } of plan.batch.requests) {
      if (createItem) form.items.splice(createItem.location.index, 0, createItem.item);
      else if (updateItem?.updateMask === 'questionItem.question.choiceQuestion.options') {
        const item = form.items[updateItem.location.index];
        if (item.itemId !== updateItem.item.itemId) throw new Error('Form patch index differs from original item');
        item.questionItem.question.choiceQuestion.options = updateItem.item.questionItem.question.choiceQuestion.options;
      } else if (updateSettings?.updateMask === 'emailCollectionType')
        form.settings.emailCollectionType = updateSettings.settings.emailCollectionType;
      else throw new Error('Unknown Form patch');
    }
  }
  for (const batch of [packet.rows.mainIdentityBatch, packet.publication.batches.main, packet.publication.batches.management]) {
    const book = after.resources.find((r) => r.providerId === batch.spreadsheetId && r.kind === 'workbook');
    for (const request of batch.requests) {
      const [kind] = Object.keys(request),
        op = request[kind];
      const id = op.start?.sheetId ?? op.sheetId ?? op.range?.sheetId ?? op.table?.range?.sheetId;
      const sheet = book?.sheets.find((s) => s.metadata.properties.sheetId === id);
      if (!sheet) throw new Error('Unknown native batch destination');
      if (kind === 'updateCells' && ['userEnteredValue', 'userEnteredValue,chipRuns'].includes(op.fields)) {
        for (const [r, row] of op.rows.entries())
          for (const [c, value] of row.values.entries()) {
            const y = op.start.rowIndex + r,
              x = op.start.columnIndex + c;
            if (
              y >= sheet.metadata.properties.gridProperties.rowCount ||
              x >= sheet.metadata.properties.gridProperties.columnCount
            )
              throw new Error('Native batch exceeds original grid');
            const cell = (sheet.rows[y][x] ??= {});
            for (const field of op.fields.split(',')) {
              if (Object.hasOwn(value, field)) cell[field] = value[field];
              else delete cell[field];
            }
          }
      } else if (kind === 'appendDimension' && op.dimension === 'COLUMNS')
        sheet.metadata.properties.gridProperties.columnCount += op.length;
      else if (kind === 'updateTable' && op.fields === 'range')
        sheet.metadata.tables.find((t) => t.tableId === op.table.tableId).range = op.table.range;
      else if (kind === 'repeatCell' || kind === 'updateDimensionProperties')
        continue; // presentation needs native readback
      else throw new Error('Unknown Sheets patch');
    }
  }
  delete after.snapshotSha256;
  after.snapshotSha256 = importDigest(after);
  verifyNativeContinuity(packet, production, { published: true });
  verifyPublishedTables(packet, after);
  verifyOriginalResponses(packet, after);
  return { capture: after, production };
}
