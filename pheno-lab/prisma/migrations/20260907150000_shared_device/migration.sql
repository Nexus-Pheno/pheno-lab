-- Shared lab tablets (kiosk mode): registered devices whose sessions get
-- idle/absolute timeouts and single-active-user displacement. Additive only.

-- CreateTable
CREATE TABLE "SharedDevice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "setupToken" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "currentUserId" TEXT,
    "lastActivityAt" TIMESTAMP(3),

    CONSTRAINT "SharedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SharedDevice_setupToken_key" ON "SharedDevice"("setupToken");

-- CreateIndex
CREATE INDEX "SharedDevice_organizationId_idx" ON "SharedDevice"("organizationId");

-- AddForeignKey
ALTER TABLE "SharedDevice" ADD CONSTRAINT "SharedDevice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedDevice" ADD CONSTRAINT "SharedDevice_currentUserId_fkey" FOREIGN KEY ("currentUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
