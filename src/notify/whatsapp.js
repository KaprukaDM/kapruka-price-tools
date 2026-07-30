// Minimal WhatsApp Cloud API sender — used to notify when a partner site
// couldn't be added automatically, so someone knows a custom scraper needs
// to be built for it. See config in .env (WA_TOKEN/WA_PHONE_ID/WA_ADMIN_NUMBER).
//
// Note: Meta only allows freeform text outside an approved template if the
// recipient has messaged this WhatsApp Business number within the last 24h
// (or the number is a sandbox test recipient). If a send fails with an error
// about templates/24-hour window, that's why — message the business number
// once from WA_ADMIN_NUMBER to reopen the window, or set up an approved
// template for unattended notifications.

import 'dotenv/config';

const WA_TOKEN = process.env.WA_TOKEN || '';
const WA_PHONE_ID = process.env.WA_PHONE_ID || '';
const WA_ADMIN_NUMBER = process.env.WA_ADMIN_NUMBER || '';

export function whatsappConfigured() {
  return !!(WA_TOKEN && WA_PHONE_ID && WA_ADMIN_NUMBER);
}

export async function sendWhatsAppMessage(text, to = WA_ADMIN_NUMBER) {
  if (!whatsappConfigured()) {
    throw new Error('WhatsApp is not configured (WA_TOKEN/WA_PHONE_ID/WA_ADMIN_NUMBER missing from .env).');
  }
  const res = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`WhatsApp send failed (${res.status}): ${data?.error?.message || JSON.stringify(data)}`);
  }
  return data;
}
