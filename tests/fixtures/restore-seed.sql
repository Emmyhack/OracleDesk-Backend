-- Minimal pre-backup data for the restore drill (#146).
INSERT INTO users (id, "walletAddress", "identityKey", email, "createdAt", "updatedAt")
VALUES ('restore-user', 'GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF', 'GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF', NULL, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO markets (id, question, category, status, "settlementCurrency", "initialYesProb", "confidenceInterval", "expiryTimestamp", "minimumLiquidity", "totalLiquidity", "createdAt", "updatedAt")
VALUES ('restore-market', 'Restore drill market?', 'MACRO', 'ACTIVE', 'USDC', 0.5, '{"lower":0.4,"upper":0.6}'::jsonb, now() + interval '30 days', 100, 100, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO chain_events (id, "contractId", "contractName", "eventName", ledger, "ledgerClosedAt", "txHash", params, "createdAt")
VALUES ('restore-event', 'CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O', 'marketCore', 'trade', 4951600, now(), repeat('a', 64), '{}'::jsonb, now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO indexer_cursors (id, "lastLedger", "updatedAt")
VALUES ('stellar:Test SDF Network ; September 2015', 4951600, now())
ON CONFLICT (id) DO UPDATE SET "lastLedger" = EXCLUDED."lastLedger";
