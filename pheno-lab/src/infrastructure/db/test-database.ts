type TestDatabaseCheck = {
  testDatabaseUrl: string;
  primaryDatabaseUrl?: string;
  ci?: boolean;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function parsePostgresUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(`${name} must use PostgreSQL`);
  }
  return url;
}

export function assertSafeTestDatabaseUrl({
  testDatabaseUrl,
  primaryDatabaseUrl,
  ci = false,
}: TestDatabaseCheck): URL {
  const testUrl = parsePostgresUrl(testDatabaseUrl, "TEST_DATABASE_URL");
  const databaseName = decodeURIComponent(testUrl.pathname.replace(/^\//, ""));
  if (!databaseName.endsWith("_test")) {
    throw new Error("The test database name must end with _test");
  }

  if (primaryDatabaseUrl) {
    const primaryUrl = parsePostgresUrl(primaryDatabaseUrl, "DATABASE_URL");
    if (primaryUrl.toString() === testUrl.toString()) {
      throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL");
    }
  }

  if (!ci && !LOOPBACK_HOSTS.has(testUrl.hostname)) {
    throw new Error("Outside CI, the test database must use a loopback host");
  }

  return testUrl;
}
