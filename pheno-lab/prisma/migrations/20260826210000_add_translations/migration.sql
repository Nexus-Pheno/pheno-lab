-- Cached machine translations of user-entered free text.
CREATE TABLE "Translation" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "sourceLang" TEXT NOT NULL,
  "targetLang" TEXT NOT NULL,
  "translatedText" TEXT NOT NULL,
  "model" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Translation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Translation_organizationId_sourceHash_targetLang_key"
  ON "Translation"("organizationId", "sourceHash", "targetLang");
