-- #82 seed policy record on the market row
SET lock_timeout = '5s';

ALTER TABLE "markets" ADD COLUMN "seedPolicy" JSONB;
