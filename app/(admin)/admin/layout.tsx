import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentMember } from "@/lib/auth/current-member";

export const dynamic = "force-dynamic";

const NAV = [
  ["/admin", "Overview"],
  ["/admin/members", "Members"],
  ["/admin/loans", "Loans"],
  ["/admin/disputes", "Disputes"],
  ["/admin/catalogue", "Catalogue"],
  ["/admin/payouts", "Payouts"],
  ["/admin/health", "Health"],
] as const;

/**
 * Requirement 13.1: every /admin route is gated on members.is_admin, which is
 * set only via SQL. Non-admins get a 404, not a 403, so the surface is not
 * discoverable. Middleware already redirects signed-out visitors to login.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const member = await getCurrentMember();
  if (!member?.isAdmin) notFound();

  return (
    <div className="flex min-h-dvh">
      <aside className="w-52 shrink-0 border-r p-4">
        <p className="mb-4 text-sm font-semibold">BookerReads admin</p>
        <ul className="flex flex-col gap-1 text-sm">
          {NAV.map(([href, label]) => (
            <li key={href}>
              <Link href={href} className="hover:bg-muted block rounded px-2 py-1">
                {label}
              </Link>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground mt-6 text-xs">{member.displayName}</p>
        <Link href="/shelf" className="text-xs underline">
          Back to app
        </Link>
      </aside>
      <main className="min-w-0 flex-1 p-6">{children}</main>
    </div>
  );
}
