/**
 * Provider adapters. Both take a fetcher so tests can stub the network.
 * Phone numbers are E.164 without plus ("91xxxxxxxxxx").
 */

export type SendResult =
  { ok: true; providerRef: string } | { ok: false; error: string; retryable: boolean };

export type WhatsAppProvider = {
  sendTemplate(input: {
    phone: string;
    template: string;
    bodyParams: string[];
  }): Promise<SendResult>;
};
export type SmsProvider = {
  sendText(input: { phone: string; text: string }): Promise<SendResult>;
};

function classify(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Interakt WhatsApp Business API: https://www.interakt.shop/resource-center/api */
export function interaktProvider(opts: {
  apiKey: string;
  fetcher?: typeof fetch;
}): WhatsAppProvider {
  const fetcher = opts.fetcher ?? fetch;
  return {
    async sendTemplate({ phone, template, bodyParams }) {
      try {
        const res = await fetcher("https://api.interakt.ai/v1/public/message/", {
          method: "POST",
          headers: { authorization: `Basic ${opts.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            countryCode: `+${phone.slice(0, 2)}`,
            phoneNumber: phone.slice(2),
            type: "Template",
            template: { name: template, languageCode: "en", bodyValues: bodyParams },
          }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          id?: string;
          result?: boolean;
          message?: string;
        };
        if (!res.ok || json.result === false)
          return {
            ok: false,
            error: json.message ?? `HTTP ${res.status}`,
            retryable: classify(res.status),
          };
        return { ok: true, providerRef: json.id ?? `interakt:${Date.now()}` };
      } catch (e) {
        return { ok: false, error: (e as Error).message, retryable: true };
      }
    },
  };
}

/** MSG91 transactional SMS: https://docs.msg91.com/sms */
export function msg91Provider(opts: {
  authKey: string;
  senderId: string;
  fetcher?: typeof fetch;
}): SmsProvider {
  const fetcher = opts.fetcher ?? fetch;
  return {
    async sendText({ phone, text }) {
      try {
        const res = await fetcher("https://control.msg91.com/api/v5/flow/", {
          method: "POST",
          headers: { authkey: opts.authKey, "content-type": "application/json" },
          body: JSON.stringify({
            sender: opts.senderId,
            route: "4",
            country: "91",
            sms: [{ message: text, to: [phone] }],
          }),
        });
        const json = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
        if (!res.ok || json.type === "error")
          return {
            ok: false,
            error: json.message ?? `HTTP ${res.status}`,
            retryable: classify(res.status),
          };
        return { ok: true, providerRef: json.message ?? `msg91:${Date.now()}` };
      } catch (e) {
        return { ok: false, error: (e as Error).message, retryable: true };
      }
    },
  };
}

/** NOTIFY_MODE=mock: logs and reports success so local flows complete end to end. */
export function mockProviders(log: (line: string) => void = (l) => console.log(l)): {
  whatsapp: WhatsAppProvider;
  sms: SmsProvider;
} {
  return {
    whatsapp: {
      async sendTemplate({ phone, template, bodyParams }) {
        log(`[notify:mock:whatsapp] ${phone} ${template} ${JSON.stringify(bodyParams)}`);
        return { ok: true, providerRef: `mock:wa:${crypto.randomUUID()}` };
      },
    },
    sms: {
      async sendText({ phone, text }) {
        log(`[notify:mock:sms] ${phone} ${text}`);
        return { ok: true, providerRef: `mock:sms:${crypto.randomUUID()}` };
      },
    },
  };
}
