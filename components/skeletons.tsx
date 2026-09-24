/** Shared loading skeletons for route-level loading.tsx files (Requirement 14.3). */

export function TitleSkeleton({ width = "w-40" }: { width?: string }) {
  return <div className={`h-8 ${width} bg-muted animate-pulse rounded`} aria-hidden />;
}

export function LineSkeleton({ width = "w-full" }: { width?: string }) {
  return <div className={`h-4 ${width} bg-muted animate-pulse rounded`} aria-hidden />;
}

export function CardListSkeleton({ rows = 4, cover = true }: { rows?: number; cover?: boolean }) {
  return (
    <ul className="flex flex-col gap-3" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex gap-3 rounded-lg border p-3">
          {cover && <div className="bg-muted aspect-[2/3] w-12 shrink-0 animate-pulse rounded" />}
          <div className="flex flex-1 flex-col gap-2 py-1">
            <LineSkeleton width="w-3/4" />
            <LineSkeleton width="w-1/2" />
            <LineSkeleton width="w-1/3" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function GridSkeleton({
  items = 8,
  cols = "grid-cols-4 sm:grid-cols-6",
}: {
  items?: number;
  cols?: string;
}) {
  return (
    <ul className={`grid ${cols} gap-3`} aria-hidden>
      {Array.from({ length: items }, (_, i) => (
        <li key={i} className="flex flex-col gap-1">
          <div className="bg-muted aspect-[2/3] animate-pulse rounded" />
          <LineSkeleton width="w-3/4" />
        </li>
      ))}
    </ul>
  );
}

export function PageSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-4">
      <TitleSkeleton />
      <CardListSkeleton rows={rows} />
    </div>
  );
}
