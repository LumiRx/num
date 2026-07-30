# Restoring NUM from a backup

Backups live in `~/Backups/NUM/<timestamp>/`, produced by `ops/backup.sh`.

## Restore the code

The bundle is a complete git repository in one file — all branches, full history.

```bash
git clone ~/Backups/NUM/<timestamp>/num-repo.bundle num-restored
cd num-restored && git log --oneline -5
```

If `worktree-dirty.tgz` is present, the backup was taken with uncommitted changes.
Unpack it over the clone to recover them:

```bash
tar -xzf ~/Backups/NUM/<timestamp>/worktree-dirty.tgz -C num-restored
```

Off-machine copy: branch `backend-fastapi` on `github.com/LumiRx/num`.
Note that `main` on that remote is a **different codebase** (the Cloudflare
Worker / console project) with no shared history — never force-push between them.

## Restore the database

There is no `pg_dump` file, because we have no direct Postgres URL for the
production project. Rebuilding is a three-step job:

1. **Create the project** (or use an existing empty one).
2. **Run the migrations in order** — `migrations/0001_*.sql` upward, via the
   Supabase SQL editor or `apply_migration`. This recreates tables, RLS
   policies, triggers, and constraints.
3. **Load the rows** from `data/*.json`, parents before children:

   ```
   partner_tenants → partners → users → channel_identities → conversations
   → messages → memories → llm_usage → events → consent_events
   → vendors → leads → bookings → acquisition_sources
   ```

   Each file is a JSON array straight from PostgREST, so it can be POSTed back
   to `/rest/v1/<table>` with the service key, or loaded with a short script.

### What this does not cover

- Sequence positions
- Storage bucket objects (`chat-media`)
- Anything written after the backup ran

**This is the reason to move production onto a Supabase project the team can
administer.** Supabase's own daily backups and point-in-time recovery are a real
database backup; this script is a stopgap for a database we can only reach
through its REST API.

## Verify a restore

```bash
./ops/db_inventory.sh          # row counts per table
curl -s <app-url>/healthz/db   # {"status":"ok","db":"ok"}
```
