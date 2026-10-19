# Security Policy

## Status: testnet only, unaudited

This backend talks to OracleDesk contracts deployed on Stellar **testnet
only**. Nothing has been professionally audited. Don't run it with mainnet
funds or keys. See [docs/STATUS.md](docs/STATUS.md) for what is and isn't
verified.

## Reporting a vulnerability

Report privately, not in a public issue:

- [GitHub Security Advisories](../../security/advisories/new) for this
  repository, or
- email **SECURITY-CONTACT-TBD@example.invalid**
  <!-- TODO(maintainer): replace with the real private disclosure address. -->

<!-- TODO(maintainer): state a triage/response timeline once you have one. -->

In scope, for example:

- Logging in as an address you don't control (`/auth/challenge`, `/auth/verify`).
- Getting a subscription without a matching on-chain USDC transfer, or
  reusing someone else's payment (`payment-verification.service.ts`).
- Reaching an admin endpoint without being in `ADMIN_ADDRESSES`.
- Making the backend sign or submit a transaction in `dry-run` mode, or on
  a network other than testnet in `live` mode.
- A trace marked verified whose bytes don't match the on-chain hash.
- Secrets in logs or API responses.

Out of scope: the contracts (report to
[OracleDesk-SmartContract](https://github.com/OracleDesk/OracleDesk-SmartContract)),
the frontend (report to
[OracleDesk-Frontend](https://github.com/OracleDesk/OracleDesk-Frontend)), and
third-party dependencies unless this repo's use of them is what's
exploitable.

## Channel accounts note (#37)

Channel accounts are configured on Stellar testnet exclusively as parallel transaction source accounts to prevent sequence collisions during concurrent agent submissions. Channel keys hold only minimal fee XLM and have no permissions, roles, or allowances in the treasury or market-core contracts. Compromise of a channel key cannot move treasury capital, create markets, or trade shares, as all privileged operations require invocation authorization entries signed by the agent key (`AGENT_SECRET_KEY`).
