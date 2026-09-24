"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { setConfigAction } from "./actions";

type Entry = { key: string; description: string; value: string; updatedAt: string | null };

export function ConfigEditor({ entries }: { entries: Entry[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, start] = useTransition();

  return (
    <ul className="divide-y rounded-lg border text-sm">
      {entries.map((e) => (
        <li key={e.key} className="flex flex-col gap-1 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="font-mono font-medium">{e.key}</span>
              <span className="text-muted-foreground ml-2 text-xs">{e.description}</span>
            </div>
            {editing === e.key ? (
              <div className="flex gap-1">
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const r = await setConfigAction(e.key, draft);
                      if (r.ok) {
                        toast.success("Saved");
                        setEditing(null);
                        router.refresh();
                      } else toast.error(r.message);
                    })
                  }
                >
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditing(e.key);
                  setDraft(e.value);
                }}
              >
                Edit
              </Button>
            )}
          </div>
          {editing === e.key ? (
            <textarea
              value={draft}
              onChange={(ev) => setDraft(ev.target.value)}
              rows={Math.min(12, draft.split("\n").length + 1)}
              className="bg-background rounded border p-2 font-mono text-xs"
            />
          ) : (
            <pre className="text-muted-foreground overflow-x-auto font-mono text-xs">{e.value}</pre>
          )}
        </li>
      ))}
    </ul>
  );
}
