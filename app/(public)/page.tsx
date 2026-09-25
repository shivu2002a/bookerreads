import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function LandingPage() {
  return (
    <section className="flex flex-col gap-10 py-8">
      <div className="flex flex-col gap-4">
        <p className="kicker">A lending library kept by neighbours · Bangalore</p>
        <h1 className="text-4xl leading-tight font-semibold sm:text-5xl">
          Every shelf on your street, open to you.
        </h1>
        <p className="drop-cap text-lg leading-relaxed">
          BookerReads is a members-only lending circle for Bangalore neighbourhoods. List the books
          you already own at a price you choose, borrow from readers within a fifteen-minute walk,
          and earn whenever your books go out.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button size="lg" render={<Link href="/login" />}>
          Join with your phone number
        </Button>
        <Button size="lg" variant="outline" render={<Link href="/c/central-east" />}>
          Browse the Central-East shelves
        </Button>
      </div>

      <p className="fleuron" aria-hidden>
        ❦
      </p>

      <dl className="grid gap-8 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <dt className="kicker">I.</dt>
          <dd className="font-heading text-lg font-semibold">Listing costs nothing</dd>
          <dd className="text-muted-foreground text-sm leading-relaxed">
            Scan the barcode, photograph your copy, and it joins the catalogue. The book remains
            yours.
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="kicker">II.</dt>
          <dd className="font-heading text-lg font-semibold">Pay per book, no subscription</dd>
          <dd className="text-muted-foreground text-sm leading-relaxed">
            Each lender names a price, often the cost of a coffee, sometimes nothing. Leave a
            refundable deposit and request any volume in your cluster.
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="kicker">III.</dt>
          <dd className="font-heading text-lg font-semibold">Lenders set the price</dd>
          <dd className="text-muted-foreground text-sm leading-relaxed">
            Name your rental price and loan period. When the book goes out, the price less a small
            platform fee is yours, paid monthly by UPI.
          </dd>
        </div>
      </dl>

      <blockquote className="border-primary/40 text-muted-foreground border-l-2 pl-4 text-sm italic">
        “A room without books is like a body without a soul.” — attributed to Cicero
      </blockquote>
    </section>
  );
}
