---
title: cex-wallet/module-env-loading-rule
type: rule
permalink: cex-wallet/cex-wallet-module-env-loading-rule
tags:
- cex-wallet
- env
- startup
---

# cex-wallet/module-env-loading-rule

## Rule

All module entrypoints must import and execute their local `./loadEnv` at the earliest possible stage, before importing modules that read `process.env`, initialize clients, create signers, open databases, or construct service singletons.

## Required Loading Order

1. Load the repository root `keys.env` first. This file is the shared source for cross-module keys and public verification keys.
2. Load the module-local `.env` second with override enabled. Module `.env` values may intentionally override shared values for that module.

## Implementation Notes

- New modules and new startup entrypoints must follow this order from their first executable import, for example `import './loadEnv';` as the first import in TypeScript entry files.
- Avoid reading env vars at module top level before `loadEnv` has run.
- This rule applies to scan modules, wallet, signer, db_gateway, risk_control, and future module entrypoints in this repo.

## Reason

Several modules construct clients/signers during import. Loading env after those imports can bind stale or missing values and cause failures such as bad Ed25519 key sizes or db_gateway signature verification mismatches.