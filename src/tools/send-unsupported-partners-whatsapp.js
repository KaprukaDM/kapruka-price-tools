// One-off: send the current unsupported_partners worklist to WhatsApp.
// Run with: node src/tools/send-unsupported-partners-whatsapp.js
import { listUnsupportedPartners } from '../db.js';
import { sendWhatsAppMessage, whatsappConfigured } from '../notify/whatsapp.js';

if (!whatsappConfigured()) {
  console.error('WhatsApp is not configured — set WA_TOKEN/WA_PHONE_ID/WA_ADMIN_NUMBER in .env.');
  process.exit(1);
}

const rows = await listUnsupportedPartners();

const text = rows.length
  ? `🔧 Unsupported partner sites — custom scrapers needed (${rows.length}):\n\n` +
    rows
      .map((r, i) => `${i + 1}. ${r.name || '(no name)'} — ${r.partner_site}\n   Reason: ${r.reason} — ${r.detail}`)
      .join('\n\n')
  : '✅ No unsupported partner sites logged right now.';

await sendWhatsAppMessage(text);
console.log(`Sent (${rows.length} site${rows.length === 1 ? '' : 's'}).`);
