---
title: README
type: note
permalink: cex-wallet/fund-rebalance/readme
---

# Fund Rebalance

`fund_rebalance` is a small TypeScript service for scheduled EVM and Solana fund collection.

It consumes finalized deposit rows written by the scan services, checks only candidate address/token pairs on-chain, and sends funds to an active hot wallet through the existing `risk_control`, `signer`, and `db_gateway` services.

## Scope

- EVM native and ERC20 collection.
- Solana native SOL, SPL Token, and SPL Token-2022 collection.
- Native token collection transfers `balance - estimated_gas_fee`.
- ERC20 collection transfers the full ERC20 balance when the user address has enough native gas.
- ERC20 addresses without native gas are funded from the selected hot wallet first, then collected after the gas funding transaction confirms.
- SPL / Token-2022 addresses without enough SOL fee are funded from the selected Solana hot wallet first, then collected after the fee funding transaction confirms.
- Cold wallet tiering is intentionally out of scope.

## Setup

```bash
cp env.example .env
npm install
npm run dev
```

Required upstream services:

- `db_gateway`
- `risk_control`
- `signer`
- EVM RPC node
- Solana RPC node

The service reuses `WALLET_PRIVATE_KEY` for DB gateway and signer business signatures. `db_gateway` must have the matching `WALLET_PUBLIC_KEY`.

ERC20 gas top-up settings:

- `ERC20_GAS_TOP_UP_ENABLED=true` enables the closed loop for ERC20 addresses that have token balance but no native gas.
- `ERC20_GAS_TOP_UP_BUFFER_BPS=15000` funds 1.5x the estimated ERC20 collection fee.
- `ERC20_GAS_TOP_UP_MAX_WEI` caps a single top-up. Local development may leave it empty; production should set an explicit ceiling.
- `ERC20_GAS_TOP_UP_MIN_WEI` prevents very small top-ups from failing again because of fee movement.

Solana settings:

- `SOLANA_RPC_URL` is the primary Solana RPC endpoint; local development defaults to `http://127.0.0.1:8899`.
- `SOLANA_RPC_URL_BACKUP` is optional and is used when the primary RPC request fails.
- `SOLANA_CHAIN_ID=900` keeps Solana tasks separate from the EVM `CHAIN_ID`.
- `SOLANA_FEE_TOP_UP_ENABLED=true` enables the closed loop for SPL / Token-2022 addresses that have token balance but no SOL fee.
- `SOLANA_FEE_TOP_UP_BUFFER_BPS=15000` funds 1.5x the estimated Solana token transfer fee.
- `SOLANA_FEE_TOP_UP_MAX_LAMPORTS` caps a single fee top-up. Local development may leave it empty; production should set an explicit ceiling.
- `SOLANA_FEE_TOP_UP_MIN_LAMPORTS` prevents very small top-ups from failing again because of fee movement.

Candidate discovery:

- EVM uses `transactions` rows and the `evm_deposit_candidates:<CHAIN_ID>` cursor.
- Solana uses finalized `solana_transactions` rows and the `solana_deposit_candidates:<SOLANA_CHAIN_ID>` cursor.
- Low-frequency inventory reconciliation sums finalized `credits` for `deposit`, `collect`, `rebalance`, and `network_fee`, then checks only address/token pairs whose book inventory reaches `tokens.collect_amount`.

## API

- `GET /health`
- `GET /api/tasks?status=&tokenId=&address=`
- `POST /api/collect/run-once`
- `POST /api/tasks/:id/retry`

## Notes

`fund_tasks` writes are sensitive DB operations and require risk signatures. The table is declared in `db_gateway/src/db/schema.sql`; existing databases need the schema applied before this service can write tasks.
