import { getDevice } from "@/lib/auth";
import { quickUsersForDevice } from "@/modules/accounts/device-service";
import { LoginForm } from "@/components/auth/LoginForm";

// Server shell: detects whether this browser is a registered shared tablet
// (kiosk badge + name tiles) before handing off to the client form.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ claim?: string }>;
}) {
  const [{ claim }, device] = await Promise.all([searchParams, getDevice()]);
  const quickUsers = device
    ? await quickUsersForDevice(device.organizationId)
    : [];

  return (
    <LoginForm
      device={device ? { label: device.label } : null}
      quickUsers={quickUsers}
      claim={claim ?? ""}
    />
  );
}
