"use client";

/**
 * Loads Razorpay Checkout on demand (only on the activation page) and opens it.
 * Resolves with the success payload or rejects on dismiss/failure.
 */

export type CheckoutSuccess = {
  razorpay_payment_id: string;
  razorpay_order_id?: string;
  razorpay_subscription_id?: string;
  razorpay_signature: string;
};

type RazorpayCtor = new (opts: Record<string, unknown>) => {
  open: () => void;
  on: (event: string, cb: (r: unknown) => void) => void;
};

let loading: Promise<RazorpayCtor> | null = null;

function loadScript(): Promise<RazorpayCtor> {
  const w = window as unknown as { Razorpay?: RazorpayCtor };
  if (w.Razorpay) return Promise.resolve(w.Razorpay);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.async = true;
    s.onload = () =>
      w.Razorpay ? resolve(w.Razorpay) : reject(new Error("Razorpay failed to initialise"));
    s.onerror = () =>
      reject(new Error("Could not load the payment window. Check your connection."));
    document.head.appendChild(s);
  });
  return loading;
}

export async function openCheckout(input: {
  keyId: string;
  orderId?: string;
  subscriptionId?: string;
  amountPaise: number;
  description: string;
  themeColor?: string;
}): Promise<CheckoutSuccess> {
  const Razorpay = await loadScript();
  return new Promise((resolve, reject) => {
    const rz = new Razorpay({
      key: input.keyId,
      name: "BookerReads",
      description: input.description,
      currency: "INR",
      ...(input.orderId ? { order_id: input.orderId, amount: input.amountPaise } : {}),
      ...(input.subscriptionId ? { subscription_id: input.subscriptionId } : {}),
      theme: { color: input.themeColor ?? "#0f172a" },
      handler: (res: CheckoutSuccess) => resolve(res),
      modal: { ondismiss: () => reject(new Error("dismissed")) },
      // Phone is prefilled from Auth on the server side; nothing else is collected.
    });
    rz.on("payment.failed", (r: unknown) => {
      const desc = (r as { error?: { description?: string } })?.error?.description;
      reject(new Error(desc ?? "Payment failed"));
    });
    rz.open();
  });
}
