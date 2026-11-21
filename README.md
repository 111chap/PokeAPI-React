# Poke KO — Pokémon battle and gacha app

A student project built with React, Express and SQLite. Trainers can create an account, draw a starter, play turn-based battles, earn in-game coins and collect Pokémon. Pokémon data comes from [PokéAPI](https://pokeapi.co/). This is an unofficial educational project, not a commercial Pokémon product.

## Run locally

Use an up-to-date Node.js 24 LTS release (minimum supported: 22.13). SQLite is provided by Node itself; no native database dependency or database server is needed.

```sh
npm ci
npm start
```

In another terminal:

```sh
npm run dev
```

Open `http://localhost:3000`. The frontend proxies `/api` to the backend on port 5000. Use `localhost` consistently instead of mixing hostnames. A fresh, ignored database is created at `backend/data/pokemon.db`. Existing committed database snapshots are deliberately not imported. Create a new account with a password of at least eight characters; do not reuse a real account password for a demo.

Development uses a fresh random session signing key on each API restart. Restarting the API signs out existing development sessions. Optional settings can be copied from `backend/.env.example` into `backend/.env`.

## Checks

```sh
npm test
npm run build
npm audit
```

The regression tests use an in-memory database and synthetic Pokémon. They cover authentication and logout, invalid requests, origin restrictions, account isolation, replay protection, server-side battle rewards, concurrent gacha spending, and rate limiting. The build produces `frontend/dist`.

## Public deployment

- Set `NODE_ENV=production`, a newly generated `JWT_SECRET`, and `ALLOWED_ORIGINS=https://your-frontend.example`. The API refuses missing/default signing keys and non-HTTPS production origins.
- Generate a signing key locally with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`, then put it in the host's secret settings. Never put a real key in a frontend variable, source file, issue, or commit.
- Serve `frontend/dist` over HTTPS and reverse-proxy `/api` to the API on the **same public origin**. Keep the API bound to loopback unless a container or private network requires an explicit `HOST` override. Use a single API process with its SQLite file on a persistent local volume. Do not share a SQLite file over a network filesystem.
- Session cookies are HttpOnly, SameSite=Strict, and Secure in production. Login sessions expire after an hour and are invalidated on logout. The former browser-storage bearer tokens are no longer accepted.
- Battle damage, opponents, progression and rewards are calculated by the API. Clients submit only a move and expected turn. Completed or stale turns cannot pay twice. Gacha balance checks and inserts commit together.
- Keep databases, saves, environment files and `node_modules` out of source control. A clean current tree does not erase previously published files from other branches, history, forks or caches. See [SECURITY.md](SECURITY.md).

## Project status

The complete application replaces the old Create React App starter on `main`. The interface is based on the existing application from `mayi-branch`; this update hardens the API and connects the existing battle interface to server-authoritative gameplay. External PokéAPI availability is required for normal gameplay. Automated tests do not replace a full device/browser playthrough.
