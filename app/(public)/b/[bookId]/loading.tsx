import { CardListSkeleton, LineSkeleton } from "@/components/skeletons";
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-4">
        <div className="bg-muted aspect-[2/3] w-28 animate-pulse rounded" />
        <div className="flex flex-1 flex-col gap-2">
          <LineSkeleton width="w-3/4" />
          <LineSkeleton width="w-1/2" />
          <LineSkeleton width="w-1/3" />
        </div>
      </div>
      <CardListSkeleton rows={3} cover={false} />
    </div>
  );
}
