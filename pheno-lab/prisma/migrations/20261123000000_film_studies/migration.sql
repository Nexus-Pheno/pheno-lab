-- AlterTable
ALTER TABLE "ResearchReaderKey" ADD COLUMN     "filmStudies" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "filmStudyAccess" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "filmStudyAgentAccess" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "FilmStudy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "customMethod" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "interpretation" JSONB,

    CONSTRAINT "FilmStudy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilmStudyFile" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,

    CONSTRAINT "FilmStudyFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilmStudyPart" (
    "fileId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "ready" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "FilmStudyPart_pkey" PRIMARY KEY ("fileId","number")
);

-- CreateTable
CREATE TABLE "_FilmStudyToMaterial" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_FilmStudyToMaterial_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "FilmStudy_organizationId_publishedAt_id_idx" ON "FilmStudy"("organizationId", "publishedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FilmStudyFile_studyId_ordinal_key" ON "FilmStudyFile"("studyId", "ordinal");

-- CreateIndex
CREATE INDEX "_FilmStudyToMaterial_B_index" ON "_FilmStudyToMaterial"("B");

-- AddForeignKey
ALTER TABLE "FilmStudy" ADD CONSTRAINT "FilmStudy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilmStudy" ADD CONSTRAINT "FilmStudy_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilmStudyFile" ADD CONSTRAINT "FilmStudyFile_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "FilmStudy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilmStudyPart" ADD CONSTRAINT "FilmStudyPart_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FilmStudyFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_FilmStudyToMaterial" ADD CONSTRAINT "_FilmStudyToMaterial_A_fkey" FOREIGN KEY ("A") REFERENCES "FilmStudy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_FilmStudyToMaterial" ADD CONSTRAINT "_FilmStudyToMaterial_B_fkey" FOREIGN KEY ("B") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

