import { Badge } from "@/components/ui/badge";

const CONDITION_LABEL = { like_new: "Like new", good: "Good", worn: "Worn" } as const;
const AVAILABILITY_LABEL = {
  available: "Available",
  requested: "Requested",
  on_loan: "On loan",
  unlisted: "Unlisted",
  lost: "Lost",
} as const;

export function ConditionBadge({ condition }: { condition: keyof typeof CONDITION_LABEL }) {
  return <Badge variant="outline">{CONDITION_LABEL[condition]}</Badge>;
}

export function VerifiedBadge({ status }: { status: "verified" | "unverified" }) {
  if (status !== "verified") return null;
  return (
    <Badge variant="secondary" title="This copy has completed a loan or was checked in person">
      Verified
    </Badge>
  );
}

export function AvailabilityBadge({
  availability,
}: {
  availability: keyof typeof AVAILABILITY_LABEL;
}) {
  const variant =
    availability === "available"
      ? "default"
      : availability === "lost"
        ? "destructive"
        : "secondary";
  return <Badge variant={variant}>{AVAILABILITY_LABEL[availability]}</Badge>;
}

export function TrustScore({ score }: { score: number }) {
  return (
    <span className="inline-flex items-center gap-1 text-sm" title="Trust score, 0–100">
      <span className="font-medium tabular-nums">{score}</span>
      <span className="text-muted-foreground">trust</span>
    </span>
  );
}
