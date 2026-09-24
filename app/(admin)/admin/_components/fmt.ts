export const when = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "2-digit",
  hour: "numeric",
  minute: "2-digit",
});
export const day = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});
export const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
