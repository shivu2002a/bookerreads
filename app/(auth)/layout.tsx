import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-sm flex-col px-4 py-8">
      <Link href="/" className="mb-8 text-lg font-semibold tracking-tight">
        BookerReads
      </Link>
      <main className="flex-1">{children}</main>
    </div>
  );
}
