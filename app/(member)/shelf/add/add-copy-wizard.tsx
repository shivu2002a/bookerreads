"use client";

import Link from "next/link";
import { useActionState, useCallback, useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { BarcodeScanner } from "@/components/barcode-scanner";
import { PhotoCapture } from "@/components/photo-capture";
import { markInstallEligible } from "@/components/pwa";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_LOAN_PERIOD_DAYS,
  DEFAULT_RENTAL_PRICE_PAISE,
  LOAN_PERIOD_OPTIONS,
  MIN_BORROWER_TRUST_OPTIONS,
  replacementBounds,
} from "@/lib/copies/rules";
import { formatPaise } from "@/lib/money";
import {
  createCopyAction,
  createManualBookAction,
  type CreateCopyActionResult,
  type ManualBookResult,
} from "../actions";

type Book = {
  id: string;
  isbn13: string | null;
  title: string;
  authors: string[];
  publishedYear: number | null;
  coverUrl: string | null;
  listPricePaise: number | null;
  needsReview: boolean;
};

type Step =
  | { kind: "scan" }
  | { kind: "looking_up"; isbn13: string }
  | { kind: "not_found"; isbn13: string }
  | { kind: "manual"; isbn13?: string }
  | { kind: "confirm"; book: Book }
  | { kind: "details"; book: Book };

/** Details survive "Add another" so bulk listing is quick (task 6.1). */
type StickyDetails = {
  condition: string;
  allowedHandoffs: string[];
  minBorrowerTrust: number;
  rentalPricePaise: number;
  loanPeriodDays: number;
};
const DEFAULT_STICKY: StickyDetails = {
  condition: "good",
  allowedHandoffs: ["meetup", "courier"],
  minBorrowerTrust: 0,
  rentalPricePaise: DEFAULT_RENTAL_PRICE_PAISE,
  loanPeriodDays: DEFAULT_LOAN_PERIOD_DAYS,
};

export function AddCopyWizard({
  remaining,
  rentalBounds,
  platformFeePct,
}: {
  remaining: number | null;
  rentalBounds: { min: number; max: number };
  platformFeePct: number;
}) {
  const [step, setStep] = useState<Step>({ kind: "scan" });
  const [sticky, setSticky] = useState<StickyDetails>(DEFAULT_STICKY);
  const [added, setAdded] = useState(0);
  const left = remaining === null ? null : remaining - added;

  const onDetect = useCallback(async (isbn13: string) => {
    setStep({ kind: "looking_up", isbn13 });
    try {
      const res = await fetch(`/api/catalogue/lookup?isbn=${isbn13}`);
      if (res.status === 404) return setStep({ kind: "not_found", isbn13 });
      if (!res.ok) throw new Error(`lookup ${res.status}`);
      const json = (await res.json()) as { book: Book };
      setStep({ kind: "confirm", book: json.book });
    } catch {
      toast.error("Couldn't reach the catalogue. Check your connection and try again.");
      setStep({ kind: "scan" });
    }
  }, []);

  if (left !== null && left <= 0) {
    return (
      <div className="rounded-lg border p-4 text-sm">
        You&apos;ve reached the listing limit for a new account. Come back in a few days to add
        more.
        <div className="mt-3">
          <Button render={<Link href="/shelf" />}>Back to my shelf</Button>
        </div>
      </div>
    );
  }

  switch (step.kind) {
    case "scan":
      return (
        <div className="flex flex-col gap-4">
          {added > 0 && (
            <p className="text-muted-foreground text-sm">{added} added this session.</p>
          )}
          <BarcodeScanner onDetect={onDetect} />
          <button
            type="button"
            className="text-sm underline underline-offset-2"
            onClick={() => setStep({ kind: "manual" })}
          >
            No barcode? Enter the book by hand
          </button>
        </div>
      );

    case "looking_up":
      return (
        <div className="flex flex-col gap-3">
          <div className="bg-muted aspect-[4/3] animate-pulse rounded-lg" />
          <p className="text-muted-foreground text-center text-sm">Looking up {step.isbn13}…</p>
        </div>
      );

    case "not_found":
      return (
        <div className="flex flex-col gap-4 rounded-lg border p-4">
          <p className="text-sm">
            We couldn&apos;t find <span className="font-mono">{step.isbn13}</span> in any catalogue.
            You can enter the details by hand; we&apos;ll check them and match the book later.
          </p>
          <div className="flex gap-2">
            <Button onClick={() => setStep({ kind: "manual", isbn13: step.isbn13 })}>
              Enter by hand
            </Button>
            <Button variant="outline" onClick={() => setStep({ kind: "scan" })}>
              Scan again
            </Button>
          </div>
        </div>
      );

    case "manual":
      return (
        <ManualBookForm
          onCreated={(book) => setStep({ kind: "details", book })}
          onCancel={() => setStep({ kind: "scan" })}
        />
      );

    case "confirm":
      return (
        <div className="flex flex-col gap-4">
          <BookCard book={step.book} />
          <div className="flex gap-2">
            <Button
              size="lg"
              className="flex-1"
              onClick={() => setStep({ kind: "details", book: step.book })}
            >
              Yes, this is it
            </Button>
            <Button size="lg" variant="outline" onClick={() => setStep({ kind: "scan" })}>
              Not this book
            </Button>
          </div>
        </div>
      );

    case "details":
      return (
        <DetailsForm
          book={step.book}
          sticky={sticky}
          onSaved={(details) => {
            setSticky(details);
            setAdded((n) => n + 1);
            markInstallEligible();
            toast.success(`${step.book.title} is on your shelf`);
            setStep({ kind: "scan" });
          }}
          onBack={() => setStep({ kind: "confirm", book: step.book })}
        />
      );
  }
}

function BookCard({ book }: { book: Book }) {
  return (
    <div className="flex gap-4 rounded-lg border p-3">
      <div className="bg-muted relative h-28 w-20 shrink-0 overflow-hidden rounded">
        {book.coverUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- keeps next/image's client runtime out of this island (bundle budget)
          <img
            src={book.coverUrl}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
      </div>
      <div className="min-w-0">
        <p className="leading-tight font-medium">{book.title}</p>
        <p className="text-muted-foreground mt-1 text-sm">{book.authors.join(", ")}</p>
        {book.publishedYear && (
          <p className="text-muted-foreground text-xs">{book.publishedYear}</p>
        )}
        {book.needsReview && <p className="mt-1 text-xs text-amber-700">Pending catalogue check</p>}
      </div>
    </div>
  );
}

function DetailsForm({
  book,
  sticky,
  onSaved,
  onBack,
}: {
  book: Book;
  sticky: StickyDetails;
  onSaved: (details: StickyDetails) => void;
  onBack: () => void;
}) {
  const [state, action, pending] = useActionState<CreateCopyActionResult | null, FormData>(
    createCopyAction,
    null,
  );
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [condition, setCondition] = useState(sticky.condition);
  const [handoffs, setHandoffs] = useState<string[]>(sticky.allowedHandoffs);
  const [minTrust, setMinTrust] = useState(sticky.minBorrowerTrust);
  const [rental, setRental] = useState(
    Math.min(rentalBounds.max, Math.max(rentalBounds.min, sticky.rentalPricePaise)),
  );
  const [period, setPeriod] = useState(sticky.loanPeriodDays);
  const bounds = replacementBounds(book.listPricePaise);
  const [value, setValue] = useState(bounds.def);
  const lenderKeeps = rental - Math.floor((rental * platformFeePct) / 100);
  const fields = state && !state.ok ? (state.fields ?? {}) : {};

  useEffect(() => {
    if (state?.ok)
      onSaved({
        condition,
        allowedHandoffs: handoffs,
        minBorrowerTrust: minTrust,
        rentalPricePaise: rental,
        loanPeriodDays: period,
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per successful save
  }, [state]);

  const toggleHandoff = (h: string, on: boolean) =>
    setHandoffs((cur) => (on ? [...new Set([...cur, h])] : cur.filter((x) => x !== h)));

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="bookId" value={book.id} />
      <input type="hidden" name="condition" value={condition} />
      {handoffs.map((h) => (
        <input key={h} type="hidden" name="allowedHandoffs" value={h} />
      ))}
      <input type="hidden" name="minBorrowerTrust" value={minTrust} />
      <input type="hidden" name="replacementValuePaise" value={value} />
      <input type="hidden" name="rentalPricePaise" value={rental} />
      <input type="hidden" name="loanPeriodDays" value={period} />
      {photoPath && <input type="hidden" name="photoPath" value={photoPath} />}

      <BookCard book={book} />

      <section className="flex flex-col gap-2">
        <Label>Photo of your copy</Label>
        <PhotoCapture
          purpose="listing"
          onUploaded={setPhotoPath}
          hint="Show the front cover as it is today"
        />
        {fields.photoPath && (
          <p role="alert" className="text-destructive text-sm">
            {fields.photoPath}
          </p>
        )}
      </section>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Condition</legend>
        <RadioGroup
          value={condition}
          onValueChange={(v) => setCondition(String(v))}
          className="grid grid-cols-3 gap-2"
        >
          {[
            ["like_new", "Like new"],
            ["good", "Good"],
            ["worn", "Worn"],
          ].map(([v, label]) => (
            <label
              key={v}
              className="has-[[data-checked]]:border-foreground flex items-center justify-center gap-2 rounded-lg border p-3 text-sm"
            >
              <RadioGroupItem value={v} />
              {label}
            </label>
          ))}
        </RadioGroup>
        {fields.condition && (
          <p role="alert" className="text-destructive text-sm">
            {fields.condition}
          </p>
        )}
      </fieldset>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="value">Replacement value</Label>
          <span className="text-sm font-medium">{formatPaise(value)}</span>
        </div>
        <input
          id="value"
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={100}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          className="w-full"
        />
        <p className="text-muted-foreground text-xs">
          What a borrower pays if the book is lost. Anywhere from {formatPaise(bounds.min)} to{" "}
          {formatPaise(bounds.max)}
          {book.listPricePaise ? `; the catalogue lists it at ${formatPaise(bounds.def)}.` : "."}
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="rental">Rental price per loan</Label>
          <span className="text-sm font-medium">{rental === 0 ? "Free" : formatPaise(rental)}</span>
        </div>
        <input
          id="rental"
          type="range"
          min={rentalBounds.min}
          max={rentalBounds.max}
          step={500}
          value={rental}
          onChange={(e) => setRental(Number(e.target.value))}
          className="w-full"
        />
        <p className="text-muted-foreground text-xs">
          {rental === 0
            ? "You're lending this one for free."
            : `The borrower pays ${formatPaise(rental)} when you accept; you receive ${formatPaise(lenderKeeps)} after the ${platformFeePct}% platform fee.`}
        </p>
        {fields.rentalPricePaise && (
          <p role="alert" className="text-destructive text-sm">
            {fields.rentalPricePaise}
          </p>
        )}
      </section>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Loan period</legend>
        <RadioGroup
          value={String(period)}
          onValueChange={(v) => setPeriod(Number(v))}
          className="grid grid-cols-3 gap-2"
        >
          {LOAN_PERIOD_OPTIONS.map((d) => (
            <label
              key={d}
              className="has-[[data-checked]]:border-foreground flex items-center justify-center gap-2 rounded-lg border p-3 text-sm"
            >
              <RadioGroupItem value={String(d)} />
              {d} days
            </label>
          ))}
        </RadioGroup>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">How you&apos;ll hand it over</legend>
        {[
          ["meetup", "Meet up nearby"],
          ["courier", "Porter delivery (borrower books and pays the rider)"],
        ].map(([v, label]) => (
          <label key={v} className="flex items-center gap-3 text-sm">
            <Checkbox
              checked={handoffs.includes(v)}
              onCheckedChange={(on) => toggleHandoff(v, Boolean(on))}
            />
            {label}
          </label>
        ))}
        {fields.allowedHandoffs && (
          <p role="alert" className="text-destructive text-sm">
            {fields.allowedHandoffs}
          </p>
        )}
      </fieldset>

      <section className="flex flex-col gap-2">
        <Label htmlFor="minTrust">Minimum borrower trust score (optional)</Label>
        <select
          id="minTrust"
          value={minTrust}
          onChange={(e) => setMinTrust(Number(e.target.value))}
          className="bg-background h-9 rounded-md border px-3 text-sm"
        >
          {MIN_BORROWER_TRUST_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t === 0 ? "Anyone" : `${t} or higher`}
            </option>
          ))}
        </select>
      </section>

      <section className="flex flex-col gap-2">
        <Label htmlFor="notes">Notes (optional)</Label>
        <Textarea
          id="notes"
          name="notes"
          maxLength={300}
          rows={2}
          placeholder="e.g. Hardcover, slight marks on page 12"
        />
      </section>

      {state && !state.ok && !Object.keys(fields).length && (
        <p role="alert" className="text-destructive text-sm">
          {state.message}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="lg" className="flex-1" disabled={pending || !photoPath}>
          {pending ? "Saving…" : "Add to my shelf"}
        </Button>
        <Button type="button" size="lg" variant="outline" onClick={onBack}>
          Back
        </Button>
      </div>
    </form>
  );
}

function ManualBookForm({
  onCreated,
  onCancel,
}: {
  onCreated: (book: Book) => void;
  onCancel: () => void;
}) {
  const [state, action, pending] = useActionState<ManualBookResult | null, FormData>(
    createManualBookAction,
    null,
  );
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [authors, setAuthors] = useState("");
  const fields = state && !state.ok ? (state.fields ?? {}) : {};

  useEffect(() => {
    if (state?.ok) {
      onCreated({
        id: state.data.bookId,
        isbn13: null,
        title: state.data.title,
        authors: authors
          .split(/[,;]/)
          .map((a) => a.trim())
          .filter(Boolean),
        publishedYear: null,
        coverUrl: null,
        listPricePaise: null,
        needsReview: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per successful create
  }, [state]);

  return (
    <form action={action} className="flex flex-col gap-5">
      {photoPath && <input type="hidden" name="reviewPhotoPath" value={photoPath} />}
      <p className="text-muted-foreground text-sm">
        Photograph the title page (the one with title, author, and publisher) so we can verify the
        entry.
      </p>
      <PhotoCapture purpose="review" onUploaded={setPhotoPath} label="Photograph the title page" />
      {fields.reviewPhotoPath && (
        <p role="alert" className="text-destructive text-sm">
          {fields.reviewPhotoPath}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          name="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={200}
        />
        {fields.title && (
          <p role="alert" className="text-destructive text-sm">
            {fields.title}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="authors">Author(s)</Label>
        <Input
          id="authors"
          name="authors"
          value={authors}
          onChange={(e) => setAuthors(e.target.value)}
          required
          maxLength={200}
          placeholder="Separate with commas"
        />
        {fields.authors && (
          <p role="alert" className="text-destructive text-sm">
            {fields.authors}
          </p>
        )}
      </div>
      <input type="hidden" name="language" value="en" />
      {state && !state.ok && !Object.keys(fields).length && (
        <p role="alert" className="text-destructive text-sm">
          {state.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="lg" className="flex-1" disabled={pending || !photoPath}>
          {pending ? "Saving…" : "Continue"}
        </Button>
        <Button type="button" size="lg" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
