-- Preserve accepted commands while recording every affected projection/authority scope.
CREATE TABLE command_event_scopes (
  command_id TEXT NOT NULL REFERENCES operation_commands(command_id),
  event_id TEXT NOT NULL REFERENCES events(event_id),
  unit_id TEXT NOT NULL REFERENCES organizational_units(unit_id),
  PRIMARY KEY (command_id, event_id)
);
INSERT INTO command_event_scopes (command_id, event_id, unit_id)
SELECT command_id, event_id, unit_id FROM operation_commands;
CREATE INDEX command_scopes_projection ON command_event_scopes(event_id, unit_id, command_id);

-- A single native response cannot be resubmitted through the alternate operation.
CREATE UNIQUE INDEX commands_source_operation_family ON operation_commands (
  source_kind, source_resource, source_submission, source_revision,
  CASE WHEN operation = 'excusal.submitMany' THEN 'excusal.submit' ELSE operation END
);
-- A changed attendance/excusal Form response requires a correction workflow, not
-- a new revision of the original submission that silently creates more evidence.
CREATE UNIQUE INDEX commands_native_form_submission ON operation_commands (
  source_resource, source_submission,
  CASE WHEN operation = 'excusal.submitMany' THEN 'excusal.submit' ELSE operation END
) WHERE source_kind = 'form' AND operation IN ('attendance.report', 'excusal.submit', 'excusal.submitMany');
CREATE UNIQUE INDEX requests_one_event_per_submission ON excusal_requests(command_id, event_id);
