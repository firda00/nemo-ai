# Isolated trial-booking verification (no LLM)

Requires Docker Desktop **Linux engine**, installed repository dependencies, Node 24+ (native TypeScript stripping), and the Supabase CLI dependency. Run from the repository root:

```powershell
node agent-hub/trial-booking-local/setup.mjs prepare
node agent-hub/trial-booking-local/setup.mjs start
node agent-hub/trial-booking-local/setup.mjs reset
node agent-hub/trial-booking-local/integration.mjs
```

To open the existing chat against this isolated database:

```powershell
node agent-hub/trial-booking-local/app.mjs
```

Open `http://127.0.0.1:55439/auth`. After successful seeding, `agent-hub/trial-booking-local/local-login.json` contains only synthetic fixture login credentials (ownerA/operatorA/viewerA/ownerB). This file is git-ignored and protected with a current-user-only Windows ACL, or mode 0600 on Unix. Inspect it locally; do not paste its contents into reports. Separate browser profiles allow owner and operator approval handoff. The launcher disables all Vite `.env` loading, clears inherited `VITE_*` variables, and injects only this isolated project's URL/anon key into process memory. It does not modify root environment files or print keys. `/app` contains the existing local trial-booking chat card; no new screen is required. Resetting the database invalidates old fixture passwords; rerun the harness to recreate the login file.

`prepare` copies the exact migrations listed in `migration-manifest.json`; it does not create a substitute schema. The selected dependency slice is the actual initial users/accounts schema, account blocking and production-test guard, bookings, approval queue, durable runtime phases 1–2, and the new trial migration. This is **not** validation against all historical production migrations. No existing runtime kill switches are changed; no generic worker, model function or customer channel is started.

Project identity is `nemo-trial-booking-local`, HTTP port **55431**, database **55432**, shadow database **55430**, captured local mail **55434**. The harness rejects a status URL different from `http://127.0.0.1:55431`. Auth administrator credentials are read from this local CLI status in memory, never printed or stored. Application calls use genuine GoTrue password-session JWTs and the same `src/lib/trialBookingClient.ts` transport as the chat. Seed writes alone use the local service role.

The seed recreates two synthetic organizations, four synthetic users (owner/operator/viewer in A, owner in B), two courses and six sessions: available, one remaining seat, fully booked, cancelled, foreign organization, and a multiple-retry fixture. All data is synthetic. Session times are seven days after seeding, starting at **15:00 Asia/Tashkent (UTC+05:00)**. Relative future times keep the fixture reproducible without expiring. UUIDs and the ephemeral local password are generated per run. Rerun `reset` before every harness run; do not rerun seed against a populated fixture.

These preconfigured synthetic accounts have real Auth metadata `onboarding_completed: true` and `lang: en`; the normal application's onboarding guard remains enabled. The local email provider is enabled in `[auth.email]`, while global `[auth].enable_signup=false` prohibits public signup. Table ACLs are explicit in the trial migration; RLS is retained and browser roles have no direct trial-table writes.

For automated real browser acceptance, keep `app.mjs` running and execute `node agent-hub/trial-booking-local/browser-acceptance.mjs` from a second terminal. This uses two real login sessions, never substitutes Auth/PostgREST, and blocks remote/model requests. It saves `browser-results.json` and card-only screenshots. Source hashes in results cover the working tree including dirty files; `node agent-hub/trial-booking-local/source-version.mjs` saves the detailed manifest and `--verify` checks it. Archive each result before resetting and repeat the complete 21-case harness on clean data to repeat both concurrency cases.

Results are written to ignored `results.json`, containing only test names/counts, statuses, endpoint identity and sanitized error labels. An unavailable Docker engine yields `blocked` with zero tests, never a simulated pass. Tests cover real concurrent database calls, atomic audit failure (a temporary local trigger raises on the mandatory audit insert), rights revocation and recovery. The response-loss test deliberately discards an actual committed HTTP result; it is not a literal physical cable disconnection. The unavailable-transport test uses a closed loopback TCP port; it does not represent every possible service outage. These tests are **not an LLM end-to-end evaluation**.

Cleanup affects only this isolated project's containers/volumes:

```powershell
node agent-hub/trial-booking-local/setup.mjs stop
```

Alternatively `reset` removes synthetic data while keeping the isolated environment running. It uses `db reset --local`, never `--linked` or a remote database URL. Append-only runtime audit records are cleaned by resetting only this disposable local database, rather than weakening audit immutability in application code.

If startup fails, inspect redacted CLI diagnostics:

```powershell
npm run safe:exec -- npx supabase start --workdir agent-hub/trial-booking-local -x studio,imgproxy,edge-runtime,logflare,vector,supavisor
```

Do not print raw `supabase status` output: it includes local credentials. No production credentials are needed.

Supplemental syntax/logic check when Docker is unavailable:

```powershell
node agent-hub/trial-booking-local/embedded-sql.mjs
```

This uses embedded PostgreSQL (PGlite) with explicitly substituted Auth infrastructure, a built-in SHA256 wrapper and no realtime publication. Its `embedded-results.json` is **separate** from the genuine integration results. It can catch SQL syntax, constraints, transaction rollback and sequential logic defects, but cannot establish real JWT authorization, concurrent sessions, HTTP behavior or the complete application path.
