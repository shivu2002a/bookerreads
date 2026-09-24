/**
 * Every server action returns this shape and never throws to the client
 * (design.md Error Handling). `code` is stable for the UI to branch on;
 * `message` is already plain language.
 */
export type ActionOk<T = undefined> = T extends undefined ? { ok: true } : { ok: true; data: T };
export type ActionErr = {
  ok: false;
  code: string;
  message: string;
  /** Field-level errors from validation, keyed by field name. */
  fields?: Record<string, string>;
};
export type ActionResult<T = undefined> = ActionOk<T> | ActionErr;
/** Accepts any ActionResult regardless of payload; for generic UI wrappers. */
export type AnyActionResult = { ok: true } | { ok: true; data: unknown } | ActionErr;

export const ok = <T>(data?: T): ActionResult<T> =>
  (data === undefined ? { ok: true } : { ok: true, data }) as ActionResult<T>;

export const err = (code: string, message: string, fields?: Record<string, string>): ActionErr => ({
  ok: false,
  code,
  message,
  ...(fields ? { fields } : {}),
});

/** Turns a ZodError into field errors for a form. */
export function fieldErrors(
  issues: Array<{ path: PropertyKey[]; message: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join(".") || "_";
    out[key] ??= issue.message;
  }
  return out;
}
