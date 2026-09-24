import "server-only";
import { getServerEnv } from "@/lib/env";

/**
 * Minimal typed client for the Razorpay REST API (basic auth with key id and
 * secret). Only the calls the MVP needs. Amounts are paise, as Razorpay expects.
 * https://razorpay.com/docs/api/
 */

const BASE = "https://api.razorpay.com/v1";

export type RazorpayCustomer = {
  id: string;
  name?: string;
  contact?: string;
  notes?: Record<string, string>;
};
export type RazorpayOrder = {
  id: string;
  amount: number;
  currency: string;
  receipt?: string;
  status: string;
  notes?: Record<string, string>;
};
export type RazorpayPayment = {
  id: string;
  amount: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  order_id?: string | null;
  method?: string;
  notes?: Record<string, string>;
  created_at: number;
};
export type RazorpayRefund = {
  id: string;
  payment_id: string;
  amount: number;
  status: "pending" | "processed" | "failed";
  notes?: Record<string, string>;
};

export class RazorpayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type RazorpayClient = ReturnType<typeof createRazorpayClient>;

export function createRazorpayClient(
  opts: { keyId: string; keySecret: string; fetcher?: typeof fetch } = credentials(),
) {
  const auth = `Basic ${Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString("base64")}`;
  const fetcher = opts.fetcher ?? fetch;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetcher(`${BASE}${path}`, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; description?: string };
    } & T;
    if (!res.ok) {
      throw new RazorpayError(
        res.status,
        json.error?.code ?? "unknown",
        json.error?.description ?? `Razorpay ${method} ${path} failed with ${res.status}`,
      );
    }
    return json as T;
  }

  return {
    keyId: opts.keyId,

    createCustomer(input: { memberId: string; contact: string; name?: string }) {
      // fail_existing=0 returns the existing customer for a repeated contact instead of erroring.
      return call<RazorpayCustomer>("POST", "/customers", {
        name: input.name ?? "BookerReads member",
        contact: input.contact,
        fail_existing: "0",
        notes: { member_id: input.memberId },
      });
    },

    createOrder(input: {
      amountPaise: number;
      memberId: string;
      purpose: "deposit" | "topup" | "rental";
      /** Required for rentals; lets the webhook route the capture to the loan. */
      loanId?: string;
      receipt: string;
    }) {
      return call<RazorpayOrder>("POST", "/orders", {
        amount: input.amountPaise,
        currency: "INR",
        receipt: input.receipt.slice(0, 40),
        notes: {
          member_id: input.memberId,
          purpose: input.purpose,
          ...(input.loanId ? { loan_id: input.loanId } : {}),
        },
      });
    },

    fetchPayment(id: string) {
      return call<RazorpayPayment>("GET", `/payments/${id}`);
    },

    createRefund(input: {
      paymentId: string;
      amountPaise: number;
      memberId: string;
      purpose: "deposit_refund" | "rental_refund";
      loanId?: string;
    }) {
      return call<RazorpayRefund>("POST", `/payments/${input.paymentId}/refund`, {
        amount: input.amountPaise,
        speed: "normal",
        notes: {
          member_id: input.memberId,
          purpose: input.purpose,
          ...(input.loanId ? { loan_id: input.loanId } : {}),
        },
      });
    },
  };
}

function credentials() {
  const env = getServerEnv();
  return { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET };
}

let cached: RazorpayClient | undefined;
export function getRazorpay(): RazorpayClient {
  cached ??= createRazorpayClient();
  return cached;
}
