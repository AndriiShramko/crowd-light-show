import { config } from './config.js';

// Send a Telegram DM to the owner. No-op (returns false) unless both
// TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are configured. The URL is a fixed,
// trusted endpoint (not user-controlled) — no SSRF surface.
export async function notifyTelegram(text) {
  if (!config.telegramBotToken || !config.telegramChatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegramChatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
