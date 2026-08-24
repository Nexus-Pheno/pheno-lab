import { PrismaClient } from "@prisma/client";
import {
  encryptCredentialWithKey,
  isEncryptedCredential,
} from "../src/infrastructure/crypto/credential";

const db = new PrismaClient();

async function main(): Promise<void> {
  const providers = await db.aiProvider.findMany({
    select: { id: true, organizationId: true, apiKey: true },
  });
  const legacy = providers.filter(
    (provider) => provider.apiKey && !isEncryptedCredential(provider.apiKey),
  );

  if (legacy.length > 0) {
    const key = process.env.AI_CREDENTIAL_KEY;
    if (!key) {
      throw new Error(
        `Found ${legacy.length} plaintext AI credential(s), but AI_CREDENTIAL_KEY is not configured`,
      );
    }
    for (const provider of legacy) {
      await db.$transaction([
        db.aiProvider.update({
          where: { id: provider.id },
          data: { apiKey: encryptCredentialWithKey(provider.apiKey, key) },
        }),
        db.auditEvent.create({
          data: {
            organizationId: provider.organizationId,
            actorType: "SYSTEM",
            action: "ai-provider.credential.encrypt",
            entityType: "AiProvider",
            entityId: provider.id,
          },
        }),
      ]);
    }
  }

  console.log(`Encrypted ${legacy.length} legacy AI credential(s).`);
}

main()
  .finally(() => db.$disconnect())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
