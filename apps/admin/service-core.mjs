import { PanelError } from "./errors.mjs";
import {
  parseAdminCommand,
  parseAttendanceCorrection,
  parseCommand,
  parseTransitionPlan,
  prepareTransitionRoster,
  prepareTransitionWeek,
} from "../../.build/admin/domain.mjs";
const allowed = new Set([
  "event.upsert",
  "directory.upsert",
  "leadership.upsert",
  "attendance.correct",
  "excusal.decide",
  "transition.prepare",
  "transition.accept",
  "transition.cancel",
  "transition.complete",
]);
const route = (operation) =>
  operation.startsWith("transition.")
    ? "/v1/admin/transitions/commands"
    : operation === "excusal.decide"
      ? "/v1/commands"
      : "/v1/admin/commands";
export class AdminService {
  constructor(backend, store) {
    this.backend = backend;
    this.store = store;
    this.busy = new Set();
  }
  async snapshot() {
    return this.backend.snapshot();
  }
  async propose(operation, payload) {
    if (!allowed.has(operation))
      throw new PanelError(
        "UNSUPPORTED_ACTION",
        "That action is not available in this panel.",
      );
    const id = crypto.randomUUID(),
      command = this.backend.envelope(operation, payload, `panel-${id}`);
    const snapshot = await this.snapshot(); // Live read rechecks actor authorization, even for retries/read-only views.
    let summary;
    if (
      ["event.upsert", "directory.upsert", "leadership.upsert"].includes(
        operation,
      )
    ) {
      parseAdminCommand(command);
      const key =
        operation === "event.upsert"
          ? "eventId"
          : operation === "directory.upsert"
            ? "personId"
            : "contactId";
      const rows =
        operation === "event.upsert"
          ? snapshot.events
          : operation === "directory.upsert"
            ? snapshot.people
            : snapshot.leadership;
      const current = rows.find((r) => r[key] === payload[key]);
      if (
        (current?.version ?? current?.contactVersion ?? 0) !==
        payload.expectedVersion
      )
        throw new PanelError(
          "STALE_VERSION",
          "This record changed. Reload it before saving.",
          409,
        );
      summary = {
        title: `${current ? "Update" : "Add"} ${operation.split(".")[0] === "directory" ? "cadet" : operation.split(".")[0]}`,
        target:
          payload.label ||
          [payload.profile?.firstName, payload.profile?.lastName]
            .filter(Boolean)
            .join(" ") ||
          [current?.firstName, current?.lastName].filter(Boolean).join(" "),
        changes: Object.entries(payload)
          .filter(
            ([k, v]) =>
              !["expectedVersion", "eventId", "contactId", "personId"].includes(
                k,
              ) && JSON.stringify(v) !== JSON.stringify(current?.[k]),
          )
          .map(([field, value]) => ({ field, value })),
        consequence:
          operation === "leadership.upsert"
            ? "Updates Leadership. Changing a title does not by itself grant account access."
            : "Preserves record identities and historical attendance. Spreadsheet and Form updates are queued after saving.",
      };
    } else if (operation === "attendance.correct") {
      parseAttendanceCorrection(command);
      summary = {
        title: "Correct attendance",
        target: snapshot.events.find((e) => e.eventId === payload.eventId)
          ?.label,
        changes: [
          { field: "Attendance code", value: payload.code ?? "Blank" },
          { field: "Reason", value: payload.reason },
        ],
        consequence:
          "Adds an auditable correction. Original attendance evidence is retained.",
      };
    } else if (operation === "excusal.decide") {
      parseCommand(command);
      summary = {
        title: "Record excusal decision",
        target: payload.requestId,
        changes: [
          { field: "Decision", value: payload.decision },
          { field: "Reason", value: payload.reason },
        ],
        consequence:
          "Records the decision and queues the related attendance update.",
      };
    } else if (operation === "transition.prepare") {
      const plan = parseTransitionPlan(payload.plan),
        roster = prepareTransitionRoster(plan, snapshot);
      const events = Array.from({ length: plan.schedule.weeks }, (_, i) =>
        prepareTransitionWeek(plan, roster, i),
      ).flat();
      summary = {
        title: "Prepare semester",
        target: plan.targetTerm.label,
        transitionId: plan.transitionId,
        changes: [
          {
            field: "Cadet changes",
            value: plan.people.map((p) => ({
              name:
                snapshot.people.find((x) => x.personId === p.personId)
                  ?.firstName +
                " " +
                snapshot.people.find((x) => x.personId === p.personId)
                  ?.lastName,
              status: p.flightPathStatus,
              asYear: p.asYear,
            })),
          },
          { field: "Events to create", value: events.length },
          { field: "Schedule", value: plan.schedule },
        ],
        consequence:
          "Prepares a frozen plan and requests an archive. It does not switch semesters. Acceptance remains blocked until the archive is verified.",
      };
    } else {
      if (
        !payload ||
        Object.keys(payload).sort().join(",") !==
          "expectedVersion,planHash,transitionId"
      )
        throw new PanelError(
          "INVALID_ACTION",
          "Reload the semester status before continuing.",
        );
      const status = await this.transition(payload.transitionId);
      summary = {
        title:
          operation === "transition.accept"
            ? "Activate semester"
            : operation === "transition.cancel"
              ? "Cancel semester preparation"
              : "Verify semester completion",
        target: status.plan.targetTerm.label,
        transitionId: payload.transitionId,
        changes: [{ field: "Current status", value: status.state }],
        consequence:
          "The backend rechecks the exact plan, archive and publication state. It will refuse an unsafe or stale transition.",
      };
    }
    const record = {
      id,
      command,
      summary,
      created: Date.now(),
      state: "proposed",
    };
    if (new TextEncoder().encode(JSON.stringify(record)).length > 128000)
      throw new PanelError("TOO_LARGE", "Please review a smaller change.", 413);
    const inserted = await this.store
      .prepare(
        "INSERT INTO proposals(id,binding,principal,command,summary,created,state,result) SELECT ?,?,?,?,?,?,?,NULL WHERE (SELECT COUNT(*) FROM proposals)<2000 AND (SELECT COUNT(*) FROM proposals WHERE principal=?)<500",
      )
      .run(
        id,
        this.backend.binding,
        this.backend.principalId,
        JSON.stringify(command),
        JSON.stringify(summary),
        record.created,
        record.state,
        this.backend.principalId,
      );
    if (!inserted.changes)
      throw new PanelError(
        "HISTORY_LIMIT",
        "The saved-change limit has been reached. Ask an administrator to review retained changes.",
        503,
      );
    return { id, summary, state: record.state };
  }
  async apply(id, approval) {
    if (approval !== true)
      throw new PanelError(
        "APPROVAL_REQUIRED",
        "Review and approve this change first.",
        403,
      );
    const row = await this.store
      .prepare(
        "SELECT * FROM proposals WHERE id=? AND binding=? AND principal=?",
      )
      .get(id, this.backend.binding, this.backend.principalId);
    if (!row)
      throw new PanelError("NOT_FOUND", "This change is unavailable.", 404);
    await this.snapshot(); // Current backend permission check, including completed receipts.
    if (row.state === "complete") {
      const command = JSON.parse(row.command);
      // Revalidate the operation's own current authority before replaying a receipt.
      await this.backend.post(route(command.operation), command);
      return JSON.parse(row.result);
    }
    if (["conflict", "rejected"].includes(row.state))
      throw new PanelError(
        "REVIEW_REQUIRED",
        "Reload the record and prepare a new reviewed change.",
        409,
      );
    if (row.state === "cancelled")
      throw new PanelError("CANCELLED", "This change was cancelled.", 409);
    if (row.state === "proposed" && Date.now() - row.created > 30 * 60 * 1000)
      throw new PanelError(
        "EXPIRED",
        "The preview expired. Prepare a fresh change.",
        409,
      );
    if (this.busy.has(id))
      throw new PanelError(
        "IN_PROGRESS",
        "This change is already being processed.",
        409,
      );
    if (this.store.acquire && !(await this.store.acquire(id)))
      throw new PanelError(
        "IN_PROGRESS",
        "This change is already processing. Wait a moment and retry the same saved change.",
        409,
      );
    this.busy.add(id);
    const command = JSON.parse(row.command);
    try {
      await this.store
        .prepare("UPDATE proposals SET state='applying' WHERE id=?")
        .run(id);
      if (command.operation === "transition.prepare") {
        let capture = await this.backend.post(
          "/v1/admin/transitions/prepare/begin",
          command,
        );
        // Bounded steps, durable in the existing transition store. Retry retains this exact command.
        for (
          let i = 0;
          capture.preparation?.state === "capturing" && i < 8;
          i++
        )
          capture = await this.backend.post(
            "/v1/admin/transitions/prepare/step",
            {
              ...this.backend.identity(),
              commandId: command.commandId,
              expectedSequence: capture.preparation.sequence,
            },
          );
        if (capture.preparation?.state === "capturing") {
          await this.store
            .prepare("UPDATE proposals SET state='continuing' WHERE id=?")
            .run(id);
          return {
            state: "continuing",
            message:
              "Preparation is saved. Continue to capture the next batch.",
            proposalId: id,
          };
        }
      }
      const receipt = await this.backend.post(
        route(command.operation),
        command,
      );
      const result = {
        state: "complete",
        receipt,
        message:
          command.operation === "transition.prepare"
            ? "Semester plan prepared. Waiting for its verified archive."
            : "Saved in SHAMROCK. Any required spreadsheet and Form updates are queued.",
      };
      await this.store
        .prepare("UPDATE proposals SET state='complete',result=? WHERE id=?")
        .run(JSON.stringify(result), id);
      return result;
    } catch (error) {
      const state =
        error.status === 409
          ? "conflict"
          : error.status >= 400 && error.status < 500
            ? "rejected"
            : "retryable";
      await this.store
        .prepare("UPDATE proposals SET state=? WHERE id=?")
        .run(state, id);
      throw error;
    } finally {
      this.busy.delete(id);
      await this.store.release?.(id);
    }
  }
  async transition(transitionId) {
    return this.backend.post("/v1/admin/transitions/status", {
      ...this.backend.identity(),
      transitionId,
    });
  }
  async history() {
    const rows = await this.store
      .prepare(
        "SELECT id,summary,created,state,result FROM proposals WHERE binding=? AND principal=? ORDER BY created DESC LIMIT 100",
      )
      .all(this.backend.binding, this.backend.principalId);
    return rows.map((r) => ({
      ...r,
      summary: JSON.parse(r.summary),
      result: r.result ? JSON.parse(r.result) : null,
    }));
  }
  async cancel(id) {
    const result = await this.store
      .prepare(
        "UPDATE proposals SET state='cancelled' WHERE id=? AND binding=? AND principal=? AND state='proposed'",
      )
      .run(id, this.backend.binding, this.backend.principalId);
    if (!result.changes)
      throw new PanelError(
        "NOT_CANCELLABLE",
        "Only an unsubmitted proposal can be dismissed.",
        409,
      );
    return { state: "cancelled" };
  }
  close() {
    this.store.close?.();
  }
}
