import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { assertSafeTestDatabaseUrl } from "../../src/infrastructure/db/test-database";

export const E2E_EMAIL = "technician.e2e@pheno.test";
export const E2E_PASSWORD = "e2e-password-2026";
export const E2E_MANAGER_EMAIL = "manager.e2e@pheno.test";

export default async function globalSetup() {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for Playwright");
  }
  assertSafeTestDatabaseUrl({
    testDatabaseUrl,
    primaryDatabaseUrl: process.env.DATABASE_URL,
    ci: process.env.CI === "true",
  });

  const prisma = new PrismaClient({
    datasources: { db: { url: testDatabaseUrl } },
  });
  try {
    const organization = await prisma.organization.upsert({
      where: { slug: "e2e-org" },
      update: { status: "ACTIVE" },
      create: {
        name: "E2E Organization",
        slug: "e2e-org",
        status: "ACTIVE",
      },
    });
    await prisma.user.upsert({
      where: { email: E2E_EMAIL },
      update: {
        organizationId: organization.id,
        active: true,
        role: "TECHNICIAN",
        passwordHash: await bcrypt.hash(E2E_PASSWORD, 4),
      },
      create: {
        organizationId: organization.id,
        email: E2E_EMAIL,
        name: "E2E Technician",
        active: true,
        role: "TECHNICIAN",
        passwordHash: await bcrypt.hash(E2E_PASSWORD, 4),
      },
    });
    await prisma.user.upsert({
      where: { email: E2E_MANAGER_EMAIL },
      update: {
        organizationId: organization.id,
        active: true,
        role: "MANAGER",
        passwordHash: await bcrypt.hash(E2E_PASSWORD, 4),
      },
      create: {
        organizationId: organization.id,
        email: E2E_MANAGER_EMAIL,
        name: "E2E Manager",
        active: true,
        role: "MANAGER",
        passwordHash: await bcrypt.hash(E2E_PASSWORD, 4),
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}
