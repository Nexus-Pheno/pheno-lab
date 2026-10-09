-- Additive and default-deny. Individual grants are separate audited actions.
ALTER TABLE "User" ADD COLUMN "memberAdmin" BOOLEAN NOT NULL DEFAULT false;
