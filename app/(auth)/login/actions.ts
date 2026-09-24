"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { err, ok, type ActionResult } from "@/lib/actions/result";
import { track } from "@/lib/analytics/server";
import { checkAndRecordOtpAttempt, clientIpFromHeaders, hashIp } from "@/lib/auth/otp-rate-limit";
import { hashPhone } from "@/lib/auth/phone-hash";
import { normaliseIndianMobile } from "@/lib/auth/phone";
import { ensureMemberForAuthUser } from "@/lib/members/ensure";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const phoneSchema = z.string().transform((raw, ctx) => {
  const e164 = normaliseIndianMobile(raw);
  if (!e164) {
    ctx.addIssue({ code: "custom", message: "Enter a 10-digit Indian mobile number." });
    return z.NEVER;
  }
  return e164;
});

const otpSchema = z.string().regex(/^\d{6}$/, "Enter the 6-digit code.");

/** Only allow redirects within the app. */
function safeNext(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//")
    ? next
    : "/shelf";
}

export type SendOtpResult = ActionResult<{ phone: string }>;

export async function sendOtp(_prev: unknown, formData: FormData): Promise<SendOtpResult> {
  const parsed = phoneSchema.safeParse(formData.get("phone"));
  if (!parsed.success)
    return err("invalid_phone", parsed.error.issues[0].message, {
      phone: parsed.error.issues[0].message,
    });
  const phone = parsed.data;

  const ip = clientIpFromHeaders(await headers());
  const decision = await checkAndRecordOtpAttempt(getDb(), {
    phoneHash: hashPhone(phone),
    ipHash: hashIp(ip),
  });
  if (!decision.allowed) {
    const mins = Math.max(1, Math.ceil(decision.retryAfterMs / 60_000));
    // Same message for both reasons so the response does not reveal which limit tripped.
    return err(
      "rate_limited",
      `Too many codes requested. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`,
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    phone: `+${phone}`,
    options: { channel: "sms" },
  });
  if (error) {
    console.error("signInWithOtp failed", { status: error.status, code: error.code });
    return err(
      "otp_send_failed",
      "We couldn't send a code right now. Please try again in a moment.",
    );
  }
  return ok({ phone });
}

export type VerifyOtpResult = ActionResult;

export async function verifyOtp(_prev: unknown, formData: FormData): Promise<VerifyOtpResult> {
  const phoneParsed = phoneSchema.safeParse(formData.get("phone"));
  const codeParsed = otpSchema.safeParse(String(formData.get("code") ?? "").replace(/\s/g, ""));
  if (!phoneParsed.success) return err("invalid_phone", "Start again with your phone number.");
  if (!codeParsed.success)
    return err("invalid_code", codeParsed.error.issues[0].message, {
      code: codeParsed.error.issues[0].message,
    });

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({
    phone: `+${phoneParsed.data}`,
    token: codeParsed.data,
    type: "sms",
  });
  if (error || !data.user) {
    return err("otp_invalid", "That code didn't match or has expired. Request a new one.");
  }

  const { member, created } = await ensureMemberForAuthUser(getDb(), {
    authUserId: data.user.id,
    phone: phoneParsed.data,
  });
  if (created) track(member.id, "member_registered");

  const onboarded = Boolean(member.displayName && member.clusterId);
  const next = safeNext(formData.get("next"));
  redirect(onboarded ? next : `/onboarding?next=${encodeURIComponent(next)}`);
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/");
}
