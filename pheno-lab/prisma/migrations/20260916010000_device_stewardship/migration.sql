-- Shared-tablet stewardship: managers who run the lab floor register and
-- revoke tablets without needing the whole admin role (Michael, 2026-09-16).
ALTER TABLE "User" ADD COLUMN "deviceAdmin" BOOLEAN NOT NULL DEFAULT false;
