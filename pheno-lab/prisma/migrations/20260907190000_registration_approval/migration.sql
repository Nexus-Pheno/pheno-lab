-- New self-registrations require admin approval before going live. Additive.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "pendingApproval" BOOLEAN NOT NULL DEFAULT false;
