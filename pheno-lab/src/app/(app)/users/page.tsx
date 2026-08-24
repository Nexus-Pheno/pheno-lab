import { redirect } from "next/navigation";

// User management now lives inside the organization page.
export default function UsersPage() {
  redirect("/organization");
}
