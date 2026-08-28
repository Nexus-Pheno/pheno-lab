-- Presence for the admin activity monitor: updated (throttled) on signed-in
-- requests. Additive; nullable, no backfill needed.
ALTER TABLE "User" ADD COLUMN "lastSeenAt" TIMESTAMP(3);
