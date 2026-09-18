import { InlineKeyboard, Keyboard } from 'grammy';

export function webAppButton(url: string, label = 'Ilovani ochish'): InlineKeyboard {
  return new InlineKeyboard().webApp(label, url);
}

export function webAppReplyKeyboard(url: string, label = '🚀 Ilovani ochish'): Keyboard {
  const kb = new Keyboard();
  if (url) kb.webApp(label, url);
  else kb.text(label);
  return kb.row().text('📖 Yordam').text('🏆 Reyting').resized().persistent();
}

export function adminKeyboard(dealId: number | string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Chiqarish', `admin_do_release:${dealId}`)
    .text('↩️ Qaytarish', `admin_do_refund:${dealId}`);
}
