import { TitleSkeleton } from "@/components/skeletons";
import { BookResultSkeleton } from "@/components/book-result-list";
export default function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <TitleSkeleton />
      <div className="bg-muted h-11 animate-pulse rounded-md" />
      <BookResultSkeleton />
    </div>
  );
}
