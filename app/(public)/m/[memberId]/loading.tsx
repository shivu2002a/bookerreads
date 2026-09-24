import { GridSkeleton, LineSkeleton, TitleSkeleton } from "@/components/skeletons";
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <TitleSkeleton />
      <LineSkeleton width="w-1/2" />
      <GridSkeleton items={6} cols="grid-cols-3 sm:grid-cols-4" />
    </div>
  );
}
