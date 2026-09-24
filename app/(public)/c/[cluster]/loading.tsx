import { GridSkeleton, TitleSkeleton } from "@/components/skeletons";
import { BookResultSkeleton } from "@/components/book-result-list";
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <TitleSkeleton width="w-64" />
      <GridSkeleton />
      <BookResultSkeleton rows={6} />
    </div>
  );
}
