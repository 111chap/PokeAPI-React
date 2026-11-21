# Security notes

Use the current `main` version. Older development branches are historical work and do not receive these protections automatically.

The hardening update removes account database snapshots and installed dependencies from the application tree, replaces the former hardcoded signing key, adds expiring/revocable cookie sessions, validates API requests, restricts browser origins, limits request rates and moves battle outcomes to the server. It also removes the development reset endpoint. SQLite operations affecting coins and rewards are transactional.

## Previously committed data

Account database snapshots were committed in earlier development history. Removing them from the current application does not purge old commits or other branch tips. Treat their account information and password hashes as previously exposed. Change any password reused elsewhere and generate a new signing key for any deployed instance. Existing snapshots are not automatically migrated into the new application.

Repository history cleanup needs coordination with collaborators and, where appropriate, GitHub Support. Rewriting history changes commit IDs and cannot recall copies already downloaded. The security update preserves history rather than silently rewriting contributors' branches.

## Operating limits

This is a single-process student/demo application. In-memory request limits are not a replacement for hosting-level abuse controls, and SQLite should live on a local persistent disk. Keep Node and dependencies patched, use HTTPS, and protect the host. Public source availability is not a security guarantee.

For a vulnerability, use GitHub's private vulnerability reporting if enabled or contact the repository owner privately. Do not post credentials, account records or password hashes in a public issue.
