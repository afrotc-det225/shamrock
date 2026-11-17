import { DatabaseSync } from "node:sqlite";
import { AdminService as CoreService } from "./service-core.mjs";
export class AdminService extends CoreService {
  constructor(backend, file = ":memory:") {
    const store = new DatabaseSync(file);
    store.exec(
      `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,binding TEXT NOT NULL,principal TEXT NOT NULL,command TEXT NOT NULL,summary TEXT NOT NULL,created INTEGER NOT NULL,state TEXT NOT NULL,result TEXT);`,
    );
    super(backend, store);
  }
}
