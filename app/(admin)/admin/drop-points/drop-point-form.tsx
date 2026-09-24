"use client";

import type { DropPointHours } from "@/db/schema";
import { ActionForm, Field, ReasonField } from "../_components/action-form";
import { saveDropPointAction } from "../actions";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export function DropPointForm({
  clusters,
  existing,
}: {
  clusters: Array<{ id: string; name: string }>;
  existing?: {
    id: string;
    clusterId: string;
    name: string;
    address: string;
    contact: string;
    capacity: number;
    hours: DropPointHours;
    active: boolean;
  };
}) {
  return (
    <ActionForm
      action={saveDropPointAction}
      submitLabel={existing ? "Save changes" : "Create"}
      className="grid gap-3 md:grid-cols-2"
    >
      {existing && <input type="hidden" name="id" value={existing.id} />}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Cluster</span>
        <select
          name="clusterId"
          defaultValue={existing?.clusterId ?? clusters[0]?.id}
          className="bg-background h-9 rounded-md border px-3"
        >
          {clusters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <Field name="name" label="Venue name" defaultValue={existing?.name} required />
      <Field name="address" label="Address" defaultValue={existing?.address} required />
      <Field
        name="contact"
        label="Contact (name, phone)"
        defaultValue={existing?.contact}
        required
      />
      <Field
        name="capacity"
        label="Shelf capacity"
        type="number"
        defaultValue={existing?.capacity ?? 20}
        required
      />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="active" defaultChecked={existing?.active ?? true} /> Active
        (offered for handoffs)
      </label>
      <fieldset className="md:col-span-2">
        <legend className="text-muted-foreground mb-1 text-sm">
          Opening hours (leave blank for closed)
        </legend>
        <div className="grid grid-cols-7 gap-1 text-xs">
          {DAYS.map((d) => (
            <div key={d} className="flex flex-col gap-1">
              <span className="uppercase">{d}</span>
              <input
                name={`${d}_open`}
                placeholder="10:00"
                defaultValue={existing?.hours[d]?.open ?? ""}
                className="bg-background h-8 rounded border px-1"
              />
              <input
                name={`${d}_close`}
                placeholder="20:00"
                defaultValue={existing?.hours[d]?.close ?? ""}
                className="bg-background h-8 rounded border px-1"
              />
            </div>
          ))}
        </div>
      </fieldset>
      <div className="md:col-span-2">
        <ReasonField />
      </div>
    </ActionForm>
  );
}
