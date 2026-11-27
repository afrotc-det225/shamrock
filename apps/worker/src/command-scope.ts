/** Server-created restriction evaluated with the actual command write or receipt read. Never deserialize this from an API body. */
export interface CommandScopeGuard { reportBatch?:D1PreparedStatement[]; memberReport?: true; sql: string; values: (string | number | null)[]; }
