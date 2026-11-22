import { AppShell } from "@/components/layout/app-shell";

// Every screen here reads per-user data from the API, so it is rendered on
// demand rather than prerendered at build time.
export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
