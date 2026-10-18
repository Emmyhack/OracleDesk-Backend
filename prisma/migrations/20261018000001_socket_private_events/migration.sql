-- Migration: 20261018000001_socket_private_events (#94)
-- Subscription.expiryNotifiedAt makes the PASS_EXPIRING socket event
-- at-most-once per pass, even with several API instances.
SET lock_timeout = '5s';

ALTER TABLE "subscriptions" ADD COLUMN "expiryNotifiedAt" TIMESTAMP(3);
