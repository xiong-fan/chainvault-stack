---
title: AGENTS
type: note
permalink: cex-wallet/agents
---

# Repository Guidelines

## Project Structure & Module Organization
This TypeScript CEX wallet stack is split into service modules. `wallet/` contains the main wallet API, routes, database models, tests, and mock scripts. `signer/` handles key generation and signing. `db_gateway/` owns database access, SQL schema, and signed gateway requests. `risk_control/` handles withdrawal review and risk rules. Chain scanners live in `scan/evm_scan/` and `scan/solana_scan/`. The Next.js app is in `user-frontend/`, with UI in `components/`, routes in `app/`, and helpers in `lib/`.

## Build, Test, and Development Commands
- `./scripts/start-all.sh` starts the core local stack in order: DB gateway, risk control, signer, wallet, and frontend.
- `cd wallet && npm run dev` starts the wallet API; `npm run build` compiles TypeScript.
- `cd signer && npm run dev` starts the signer; `npm test` runs signer API tests.
- `cd db_gateway && npm run dev` starts the database gateway.
- `cd user-frontend && npm run dev` starts Next.js; `npm run lint` runs frontend ESLint.
- `./start_anvil.sh` and `./start_solana_localnet.sh` start local chains for mock flows.

## Coding Style & Naming Conventions
Use strict TypeScript and keep service code inside its module. Prefer explicit types at API, database, and client boundaries. Follow existing formatting: 2-space indentation, semicolons, and single quotes. Use `camelCase` for variables and functions, `PascalCase` for classes, types, and React components, and descriptive filenames such as `withdraw-risk-rules.ts`.

## Testing Guidelines
`wallet/tests` and `signer/tests` use custom `ts-node` runners. Run `cd wallet && npm test` or `npm run test:wallet` for wallet API tests, and `cd signer && npm test` for signer tests. `db_gateway` exposes `npm test` through Jest. API tests may create SQLite data, so use development databases only.

## Commit & Pull Request Guidelines
Recent commits use short imperative messages such as `fix bug`, `refactor signer`, and `update docs`; prefer specific summaries like `fix wallet signature validation` or `add solana withdraw test`. Pull requests should name affected modules, describe behavior changes, list setup steps, include commands run, link issues when available, and add screenshots for `user-frontend` changes.

## Security & Configuration Tips
Do not commit real secrets, mnemonics, private keys, generated SQLite databases, or local backup files. Use each module's `env.example` and README as the source for required configuration. Treat `keys.env`, signer keypairs, local chain artifacts, and wallet mock outputs as development-only assets.

## 写代码规范
生成代码时在核心代码和配置时要写上通俗易懂的注释（最好是要贴合实际业务）