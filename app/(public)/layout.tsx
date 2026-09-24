import Link from "next/link";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="rule-double">
        <nav className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-4">
          <Link href="/" className="font-heading text-xl font-semibold">
            Booker<span className="text-primary">Reads</span>
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/search" className="text-muted-foreground hover:text-foreground">
              Search
            </Link>
            <Link href="/login" className="font-medium">
              Sign in
            </Link>
          </div>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{children}</main>
      <footer className="text-muted-foreground rule-double-t py-6 text-center text-xs">
        <p className="kicker">BookerReads · Bangalore · MMXXVI</p>
        <p className="mt-1">
          <Link href="/terms" className="hover:text-foreground">
            Terms
          </Link>{" "}
          ·{" "}
          <Link href="/privacy" className="hover:text-foreground">
            Privacy
          </Link>
        </p>
      </footer>
    </div>
  );
}
