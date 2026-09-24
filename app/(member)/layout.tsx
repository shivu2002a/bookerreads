import Link from "next/link";

// Every member route is per-user; never prerender.
export const dynamic = "force-dynamic";

const NAV = [
  { href: "/shelf", label: "Shelf" },
  { href: "/search", label: "Search" },
  { href: "/requests", label: "Requests" },
  { href: "/earnings", label: "Earnings" },
  { href: "/profile", label: "Me" },
] as const;

export default function MemberLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-4 pb-20">{children}</main>
      <nav className="bg-background rule-double-t fixed inset-x-0 bottom-0 pb-[env(safe-area-inset-bottom)]">
        <ul className="mx-auto flex max-w-3xl justify-around">
          {NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="text-muted-foreground hover:text-foreground flex h-14 flex-col items-center justify-center px-3 text-xs"
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
