export class ProposalStore {
  constructor(db, binding, principal) {
    Object.assign(this, { db, binding, principal });
    this.lease = crypto.randomUUID();
  }
  prepare(sql) {
    return {
      run: async (...args) => {
        const result = await this.db
          .prepare(sql)
          .bind(...args)
          .run();
        return { changes: result.meta.changes };
      },
      get: (...args) =>
        this.db
          .prepare(sql)
          .bind(...args)
          .first(),
      all: async (...args) =>
        (
          await this.db
            .prepare(sql)
            .bind(...args)
            .all()
        ).results,
    };
  }
  async acquire(id) {
    const result = await this.db
      .prepare(
        "UPDATE proposals SET lease_token=?,lease_until=?,state='applying' WHERE id=? AND binding=? AND principal=? AND lease_until<? AND state NOT IN ('cancelled','conflict','rejected') RETURNING id",
      )
      .bind(
        this.lease,
        Date.now() + 300000,
        id,
        this.binding,
        this.principal,
        Date.now(),
      )
      .first();
    return !!result;
  }
  async release(id) {
    await this.db
      .prepare(
        "UPDATE proposals SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?",
      )
      .bind(id, this.lease)
      .run();
  }
}
