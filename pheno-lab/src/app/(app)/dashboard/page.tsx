import { redirect } from "next/navigation";

// The board now lives on the homepage.
export default function DashboardRedirect() {
  redirect("/");
}
