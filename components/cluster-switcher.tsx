"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Signed-out viewers pick which open cluster's availability they see (Requirement 3.4). */
export function ClusterSwitcher({
  current,
  clusters,
}: {
  current: string;
  clusters: Array<{ slug: string; name: string }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  if (clusters.length < 2) return null;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Area</span>
      <select
        value={current}
        onChange={(e) => {
          const next = new URLSearchParams(params.toString());
          next.set("c", e.target.value);
          router.replace(`${pathname}?${next.toString()}`);
        }}
        className="bg-background h-8 rounded-md border px-2 text-sm"
      >
        {clusters.map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}
