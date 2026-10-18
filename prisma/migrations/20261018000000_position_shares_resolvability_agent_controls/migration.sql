-- Migration: 20261018000000_position_shares_resolvability_agent_controls
-- #74 market resolution details, #77/#78 share-denominated positions and
-- exits, #79 persistent agent controls. Forward-only: columns are nullable or
-- have constant defaults, so old code keeps working during a rolling deploy.
SET lock_timeout = '5s';

-- #74: resolvability block pinned in question document v2
ALTER TABLE "markets" ADD COLUMN "resolutionDetails" JSONB;

-- #77/#78: positions in shares, with mark-to-market columns
ALTER TABLE "positions"
    ADD COLUMN "sharesRaw" NUMERIC(39,0),
    ADD COLUMN "costBasisRaw" NUMERIC(39,0),
    ADD COLUMN "feesPaidRaw" NUMERIC(39,0),
    ADD COLUMN "realisedCollateralRaw" NUMERIC(39,0) NOT NULL DEFAULT 0,
    ADD COLUMN "realisedPnlRaw" NUMERIC(39,0) NOT NULL DEFAULT 0,
    ADD COLUMN "markPriceBps" INTEGER,
    ADD COLUMN "markValueRaw" NUMERIC(39,0),
    ADD COLUMN "liquidationValueRaw" NUMERIC(39,0),
    ADD COLUMN "unrealisedPnlRaw" NUMERIC(39,0),
    ADD COLUMN "markedAt" TIMESTAMPTZ(3),
    ADD COLUMN "valuationSource" TEXT,
    ADD COLUMN "illiquid" BOOLEAN NOT NULL DEFAULT false;

-- #78: latestReserves() looks up the newest Trade event of one market.
CREATE INDEX "chain_events_trade_market_id_idx"
    ON "chain_events" ((params->>'market_id'), "ledger" DESC)
    WHERE "eventName" = 'Trade';

-- #77: exit history
CREATE TABLE "position_exits" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "sharesSoldRaw" NUMERIC(39,0) NOT NULL DEFAULT 0,
    "collateralOutRaw" NUMERIC(39,0) NOT NULL,
    "maxSharesInRaw" NUMERIC(39,0) NOT NULL,
    "effectivePrice" DOUBLE PRECISION,
    "txHash" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_exits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "position_exits_positionId_idx" ON "position_exits"("positionId");

ALTER TABLE "position_exits" ADD CONSTRAINT "position_exits_positionId_fkey"
    FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- #79: agent controls
CREATE TYPE "AgentControlScope" AS ENUM ('ALL', 'MARKET_MAKER', 'TRADER');

CREATE TABLE "agent_controls" (
    "scope" "AgentControlScope" NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "source" TEXT,
    "pausedUntil" TIMESTAMP(3),
    "pausedBy" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_controls_pkey" PRIMARY KEY ("scope")
);

CREATE TABLE "agent_control_events" (
    "id" TEXT NOT NULL,
    "scope" "AgentControlScope" NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_control_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_control_events_scope_createdAt_idx" ON "agent_control_events"("scope", "createdAt");

INSERT INTO "agent_controls" ("scope", "updatedAt")
    VALUES ('ALL', CURRENT_TIMESTAMP), ('MARKET_MAKER', CURRENT_TIMESTAMP), ('TRADER', CURRENT_TIMESTAMP)
    ON CONFLICT DO NOTHING;
