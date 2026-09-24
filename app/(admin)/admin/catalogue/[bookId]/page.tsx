import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { getBookAdmin } from "@/lib/admin/catalogue";
import { listingPhotoUrl } from "@/lib/photos/url";
import { ActionForm, Field, ReasonField } from "../../_components/action-form";
import { editBookAction } from "../../actions";
import { MergeForm } from "./merge-form";

export default async function AdminBookPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  const b = await getBookAdmin(getDb(), bookId);
  if (!b) notFound();
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">{b.title}</h1>
        <p className="text-muted-foreground text-sm">
          {b.authors.join(", ")} · {b.source} · {b.copyCount} copies ·{" "}
          {b.needsReview ? "needs review" : "approved"}
          {b.mergedIntoId && (
            <>
              {" "}
              · merged into{" "}
              <Link href={`/admin/catalogue/${b.mergedIntoId}`} className="underline">
                this record
              </Link>
            </>
          )}
        </p>
        <Link href={`/b/${b.id}`} className="text-xs underline">
          Public page
        </Link>
      </header>

      <section className="grid gap-6 lg:grid-cols-[1fr_2fr]">
        <div className="flex flex-col gap-2">
          {b.reviewPhotoPath && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={listingPhotoUrl(b.reviewPhotoPath)}
              alt="Title page"
              className="rounded-lg border"
            />
          )}
          {b.coverUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={b.coverUrl} alt="Cover" className="w-32 rounded border" />
          )}
        </div>
        <div className="rounded-lg border p-4">
          <h2 className="mb-3 font-medium">Edit metadata</h2>
          <ActionForm
            action={editBookAction}
            submitLabel="Save"
            className="grid gap-3 md:grid-cols-2"
          >
            <input type="hidden" name="bookId" value={b.id} />
            <Field name="title" label="Title" defaultValue={b.title} required />
            <Field
              name="authors"
              label="Authors (comma separated)"
              defaultValue={b.authors.join(", ")}
              required
            />
            <Field name="isbn13" label="ISBN (optional)" defaultValue={b.isbn13} />
            <Field name="publisher" label="Publisher" defaultValue={b.publisher} />
            <Field name="publishedYear" label="Year" type="number" defaultValue={b.publishedYear} />
            <Field name="language" label="Language (ISO 639-1)" defaultValue={b.language} />
            <Field
              name="listPricePaise"
              label="List price (paise)"
              type="number"
              defaultValue={b.listPricePaise}
            />
            {b.needsReview && (
              <label className="flex items-center gap-2 text-sm md:col-span-2">
                <input type="checkbox" name="approve" defaultChecked /> Approve (clears the review
                flag)
              </label>
            )}
            <div className="md:col-span-2">
              <ReasonField />
            </div>
          </ActionForm>
        </div>
      </section>

      {!b.mergedIntoId && (
        <section className="rounded-lg border p-4">
          <h2 className="mb-1 font-medium">Merge into another book</h2>
          <p className="text-muted-foreground mb-3 text-xs">
            Use when this is a duplicate. Its copies and loans move to the survivor and this record
            redirects there.
          </p>
          <MergeForm duplicateId={b.id} />
        </section>
      )}
    </div>
  );
}
