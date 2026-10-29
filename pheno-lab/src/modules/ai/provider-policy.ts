/** Vendor-specific options must never be sent to another configured endpoint. */
export function isOfficialDeepSeek(provider: {
  provider: string;
  baseUrl: string;
}): boolean {
  if (provider.provider !== "deepseek") return false;
  try {
    const url = new URL(provider.baseUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.deepseek.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ["/", "/v1", "/v1/"].includes(url.pathname)
    );
  } catch {
    return false;
  }
}
