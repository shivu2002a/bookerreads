import Image from "next/image";
import { cn } from "@/lib/utils";

/** Cover thumbnail with a text fallback. Sized by the parent; keeps a 2:3 ratio. */
export function BookCover({
  src,
  title,
  className,
  sizes = "80px",
  priority = false,
}: {
  src: string | null;
  title: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
}) {
  return (
    <div className={cn("bg-muted relative aspect-[2/3] overflow-hidden rounded", className)}>
      {src ? (
        <Image src={src} alt="" fill sizes={sizes} className="object-cover" priority={priority} />
      ) : (
        <span className="text-muted-foreground absolute inset-0 flex items-center justify-center p-1 text-center text-[10px] leading-tight">
          {title}
        </span>
      )}
    </div>
  );
}
