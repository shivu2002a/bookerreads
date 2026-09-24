import { CardListSkeleton, LineSkeleton } from "@/components/skeletons";
export default function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-4">
        <div className="bg-muted aspect-[2/3] w-20 animate-pulse rounded" />
        <div className="flex flex-1 flex-col gap-2">
          <LineSkeleton width="w-3/4" />
          <LineSkeleton width="w-1/2" />
        </div>
      </div>
      <div className="bg-muted h-32 animate-pulse rounded-lg" />
      <CardListSkeleton rows={2} cover={false} />
    </div>
  );
}
