import { LineSkeleton, TitleSkeleton } from "@/components/skeletons";
export default function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <TitleSkeleton />
      <div className="bg-muted h-24 animate-pulse rounded-lg" />
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-muted h-20 animate-pulse rounded-lg" />
        ))}
      </div>
      <LineSkeleton width="w-2/3" />
    </div>
  );
}
