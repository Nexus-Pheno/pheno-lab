// Sends an operational alert through the app's configured SMTP — used by the
// server's health watchdog cron to tell the admin the service is down or was
// restarted (2026-09-07 reliability audit, R2; Michael approved).
//
//   cd /srv/pheno-lab/current/pheno-lab
//   NODE_OPTIONS=--conditions=react-server \
//     /usr/bin/node node_modules/tsx/dist/cli.mjs \
//     scripts/send-alert-email.ts <to> <subject> <body...>
import { isMailConfigured, sendMail } from "../src/infrastructure/mail/mailer";

async function main(): Promise<void> {
  const [to, subject, ...rest] = process.argv.slice(2);
  const body = rest.join(" ");
  if (!to || !subject) {
    console.error("usage: send-alert-email.ts <to> <subject> <body...>");
    process.exit(2);
  }
  if (!isMailConfigured()) {
    console.error("SMTP is not configured; alert not sent.");
    process.exit(1);
  }
  await sendMail(to, `[Pheno Lab] ${subject}`, body || subject);
  console.log(`alert sent to ${to}: ${subject}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("alert send failed:", error);
    process.exit(1);
  });
