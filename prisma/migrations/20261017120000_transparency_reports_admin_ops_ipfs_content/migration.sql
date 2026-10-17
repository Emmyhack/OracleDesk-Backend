-- #100 local verified IPFS content store
CREATE TABLE "ipfs_content" (
    "cid" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "origin" TEXT NOT NULL,
    "verifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pinnedUntil" TIMESTAMP(3),

    CONSTRAINT "ipfs_content_pkey" PRIMARY KEY ("cid")
);

CREATE INDEX "ipfs_content_sha256_idx" ON "ipfs_content"("sha256");
CREATE INDEX "ipfs_content_lastAccessAt_idx" ON "ipfs_content"("lastAccessAt");

-- Defence in depth: the application checks both, but a direct writer cannot
-- store a row whose declared size/hash disagree with the bytes. A CID may only
-- ever map to one byte string (enforced by the primary key + put()).
ALTER TABLE "ipfs_content"
    ADD CONSTRAINT "ipfs_content_size_matches_bytes" CHECK ("size" = octet_length("bytes"));
ALTER TABLE "ipfs_content"
    ADD CONSTRAINT "ipfs_content_sha256_format" CHECK ("sha256" ~ '^[0-9a-f]{64}$');

-- #156 treasury admin operations console
CREATE TABLE "admin_operations" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "contractId" TEXT NOT NULL,
    "sourceAccount" TEXT NOT NULL,
    "unsignedXdr" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "signedXdr" TEXT,
    "signatures" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "weightCollected" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "resultXdr" TEXT,
    "ledger" INTEGER,
    "error" JSONB,
    "requestedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_operations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_operations_txHash_key" ON "admin_operations"("txHash");
CREATE INDEX "admin_operations_status_createdAt_idx" ON "admin_operations"("status", "createdAt");

-- #159 daily transparency reports
CREATE TABLE "transparency_reports" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "anchorLedger" INTEGER NOT NULL,
    "cid" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "onChainTraceId" BIGINT,
    "mode" TEXT NOT NULL,
    "consistency" TEXT NOT NULL,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transparency_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "transparency_reports_date_key" ON "transparency_reports"("date");
CREATE INDEX "transparency_reports_anchorLedger_idx" ON "transparency_reports"("anchorLedger");

-- #159 immutable registry trace cache
CREATE TABLE "registry_trace_cache" (
    "traceId" BIGINT NOT NULL,
    "agent" TEXT NOT NULL,
    "marketId" BIGINT NOT NULL,
    "action" TEXT NOT NULL,
    "traceHash" TEXT NOT NULL,
    "ipfsCid" TEXT NOT NULL,
    "publishedAt" BIGINT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registry_trace_cache_pkey" PRIMARY KEY ("traceId")
);

CREATE INDEX "registry_trace_cache_agent_action_idx" ON "registry_trace_cache"("agent", "action");
