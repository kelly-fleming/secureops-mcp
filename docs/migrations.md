# Local database migrations

The numbered SQL files in `src/infra/sqlite/migrations/` define the local schema. `src/infra/sqlite/migrate.ts` reads regular `001_*.sql`, `002_*.sql`, and later files in consecutive order, checks UTF-8 and size, and hashes the exact file bytes. The build copies those assets beside the compiled migration module. The runner records each filename, content checksum, resulting schema checksum, and application time in `schema_migrations`.

Select the database explicitly before migrating. From the project root, under Node 24 in Bash:

```bash
npm ci
npm run build
npm run db:migrate -- --db-path ./data/secureops.db
```

The command uses `loadConfig`, requires `local-full` mode, and closes its connection. It never migrates the HTTP demo database. An initial empty database receives all migrations. A later run checks journal and schema checksums and applies only new files. It refuses an existing untracked schema, a preexisting empty journal, and any altered or missing recorded migration. A failed SQL statement rolls back the migration transaction, including its journal writes. Fix the migration or database state explicitly; do not edit an already applied SQL file or manufacture journal rows.

The selected path may be relative to the current working directory or absolute and must satisfy `SECUREOPS_DB_PATH` rules. The command prints only the count and latest version on success. Its failure message intentionally omits SQL, credentials, and local paths; inspect the database through trusted local tooling if further diagnosis is needed. Migration does not seed fixtures or create a reviewer identity.
