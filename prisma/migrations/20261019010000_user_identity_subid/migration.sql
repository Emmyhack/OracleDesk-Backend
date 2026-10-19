-- Migration: 20261019010000_user_identity_subid (#46)
-- Wallet login accepts muxed (M…) accounts and G… accounts with an id memo, so
-- one pooled G… account can host many sub-users. `walletAddress` becomes the
-- base signing/paying account (no longer unique alone) and the new
-- `identityKey` is the unique login identity ("G…", "G…#muxed:<id>" or
-- "G…#memo:<id>").
--
-- Forward-only. Every existing row keeps its id and walletAddress; identityKey
-- is backfilled to walletAddress before the unique index is added.
SET lock_timeout = '5s';

-- 1. Sub-identity columns. Nullable for the backfill window.
ALTER TABLE "users" ADD COLUMN "subId" TEXT;
CREATE TYPE "SubIdKind" AS ENUM ('MUXED', 'MEMO');
ALTER TABLE "users" ADD COLUMN "subIdKind" "SubIdKind";

-- 2. identityKey, backfilled from the identity walletAddress used to hold.
ALTER TABLE "users" ADD COLUMN "identityKey" TEXT;
UPDATE "users" SET "identityKey" = "walletAddress" WHERE "identityKey" IS NULL;

-- 3. Only after every row has a value: enforce NOT NULL and uniqueness. On a
--    populated table this fails loudly if the backfill produced duplicates.
ALTER TABLE "users" ALTER COLUMN "identityKey" SET NOT NULL;
CREATE UNIQUE INDEX "users_identityKey_key" ON "users"("identityKey");

-- 4. walletAddress is no longer unique alone; the non-unique index
--    (users_walletAddress_idx) added by the init migration is kept.
DROP INDEX "users_walletAddress_key";
