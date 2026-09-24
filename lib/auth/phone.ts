/**
 * Indian mobile numbers only for the MVP. Accepts "98450 12345", "+91 98450 12345",
 * "09845012345", "919845012345"; returns E.164 without the plus ("919845012345"),
 * which is the form Supabase Auth stores. Null when the input is not a plausible
 * Indian mobile number (10 digits starting 6–9).
 */
export function normaliseIndianMobile(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) digits = digits.slice(2);
  else if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `91${digits}`;
}

/** "919845012345" -> "+91 98450 12345" for display back to the owner only. */
export function formatIndianMobile(e164: string): string {
  const local = e164.slice(2);
  return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
}
