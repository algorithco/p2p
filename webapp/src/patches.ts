// patches.ts — extend legacy app with new TON-perfect, inbox, trade, channels features
import { Api } from './lib/api';
import { TG } from './lib/tg';
import { UI } from './lib/ui';
import { Wallet } from './lib/wallet';
import { mountGooeyNav, type GooeyNavHandle } from './lib/gooey-nav';

declare global {
  interface Window {
    App?: any;
  }
}

export function patchApp() {
  // Wait for legacy App to be defined
  const tryPatch = () => {
    const App = (window as any).App;
    if (!App) return setTimeout(tryPatch, 200);
    enhanceApp(App);
  };
  tryPatch();
}

function enhanceApp(App: any) {
  console.log('[Patches] enhancing App');

  // ---------- Helper: dealCard patch with search filtering hook ----------
  // Expose search state on App
  App.state.searchQuery = '';
  App.state.createdLinks = App.state.createdLinks || {};

  // ---------- Extend router to include new routes ----------
  // Legacy ROUTES is inside closure, not accessible. So we intercept hashchange and handle new routes before legacy router.
  const handled = handleHash(location.hash);
  if (handled) return;

  window.addEventListener(
    'hashchange',
    () => {
      const h = location.hash || '#/home';
      if (isNewRoute(h)) {
        // prevent legacy router handling by cleaning up and rendering our view
        // legacy router runs via its own hashchange listener; we run before it by capturing phase?
        // Instead, after short delay, override if still matching new route
        setTimeout(() => {
          if (location.hash === h && isNewRoute(h)) renderNewRoute(h);
        }, 30);
      }
    },
    true,
  );

  // Bottom navigation: GooeyNav pill (mounts into the #tabbar shell)
  mountBottomNav();

  // Intercept viewDeal to add Confirm button and enhanced pay
  patchViewDeal();

  // Patch viewHome to add search + inbox entry
  patchViewHome();
  patchViewCreate();

  // Expose new views to legacy router (added to ROUTES in src/legacy/app.js)
  // NOTE: join-request approval lives ONLY in the mini-app deal chat
  // (inline box in viewDeal/viewChat) — there is no separate inbox page.
  (window as any).__viewRating = viewRating;
  (window as any).__viewChannels = viewChannels;
  // Old #/inbox bookmarks redirect home (approval happens in deal chat now).
  if (location.hash.startsWith('#/inbox')) location.hash = '#/home';
  // Savdo page removed — old #/trade bookmarks go to Reyting.
  if (location.hash.startsWith('#/trade')) location.hash = '#/rating';
  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#/trade')) location.hash = '#/rating';
  });

  // Schedule inbox badge polling
  setTimeout(pollInboxBadge, 1200);
  setInterval(pollInboxBadge, 30000);

  // Admin is bot-only — intercept #/admin and redirect with toast
  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#/admin')) {
      setTimeout(() => {
        if (location.hash.startsWith('#/admin')) {
          UI.toast('Admin boshqaruv faqat Telegram bot orqali — /admin_release va boshqalar', 'err');
          location.hash = '#/home';
        }
      }, 30);
    }
  });
  if (location.hash.startsWith('#/admin')) {
    UI.toast('Admin faqat bot orqali', 'err');
    location.hash = '#/home';
  }

  // Visibility pause for polling timers (home 20s, chat 3.5s) — legacy uses App.chatTimer & home interval via closure
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // pause polling by clearing chatTimer if exists
      const App2 = (window as any).App;
      if (App2?.chatTimer) {
        clearInterval(App2.chatTimer);
        App2._pausedChatTimer = App2.chatTimer;
        App2.chatTimer = null;
      }
    } else {
      // resume — trigger router refresh if home
      if (location.hash === '#/home' || location.hash === '') {
        // force reload of deals via dispatch
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
      const App2 = (window as any).App;
      if (App2?._pausedChatTimer && !App2.chatTimer && location.hash.includes('/chat')) {
        // will be recreated on next viewChat load
        App2._pausedChatTimer = null;
      }
    }
  });

  // Patch viewJoin to handle token preview gracefully (already in legacy)
  // Patch profile to remove admin entry injection
  patchProfile();

  // Enhance TON pay: wrap Wallet.pay to poll chain status 3x after approval
  wrapWalletPayForVerification();

  // NOTE: one-tap pay screen lives in legacy viewDeal (no pay sheet anymore)
}

function isNewRoute(hash: string): boolean {
  return /^#\/rating/.test(hash) || /^#\/channels/.test(hash);
}

function handleHash(hash: string): boolean {
  if (!isNewRoute(hash)) return false;
  setTimeout(() => renderNewRoute(hash), 50);
  return true;
}

function renderNewRoute(hash: string) {
  if (hash.startsWith('#/rating')) return viewRating();
  if (hash.startsWith('#/channels')) return viewChannels();
}

function setTopbarPatched(title: string, opts: any = {}) {
  const el = document.getElementById('tb-title')!;
  el.textContent = title;
  const backBtn = document.getElementById('tb-back')!;
  const actBtn = document.getElementById('tb-action')!;
  const App = (window as any).App;
  if (opts.back) {
    backBtn.classList.remove('hidden');
    App.backHandler = opts.back;
  } else {
    backBtn.classList.add('hidden');
    App.backHandler = null;
  }
  if (opts.action) {
    actBtn.classList.remove('hidden');
    actBtn.innerHTML = opts.action.icon;
    App.actionHandler = opts.action.handler;
  } else {
    actBtn.classList.add('hidden');
    App.actionHandler = null;
  }
}
function setTabbarPatched(visible: boolean) {
  document.getElementById('tabbar')!.classList.toggle('hidden', !visible);
  document.getElementById('view')!.classList.toggle('no-tabbar', !visible);
}
function go(hash: string) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}
function navBack(fallback: string) {
  const App = (window as any).App;
  const prev = App.navStack?.length ? App.navStack[App.navStack.length - 1] : null;
  if (prev && prev !== (location.hash || '#/home')) {
    App._navBack = true;
    go(prev);
  } else go(fallback || '#/home');
}

const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
const svgWrap = (inner: string) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" ${STROKE} aria-hidden="true">${inner}</svg>`;
const svgPlus = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;

function patchTabbar() {
  // Legacy .tab-btn buttons are gone (GooeyNav owns #tabbar now) — kept as a
  // no-op so older cached bundles calling it don't crash. See mountBottomNav.
}

// Re-exported so the legacy entrypoint stays importable (see above).
export { patchTabbar as legacyPatchTabbar };

function mountBottomNav() {
  const tabbar = document.getElementById('tabbar');
  if (!tabbar) return;
  tabbar.innerHTML = '';
  const hashFor = (h: string) => h;
  // Order left → right: + (create) · Bosh sahifa · Reyting · Kanallar · Hisob.
  // Transparent floating nav: circular buttons, outline icons, GooeyNav goo.
  const handle: GooeyNavHandle = mountGooeyNav(tabbar, {
    items: [
      { hash: '#/create', label: 'Yangi', icon: svgPlus },
      {
        hash: '#/home',
        label: 'Bosh sahifa',
        icon: svgWrap('<path d="M4 10.5 12 4l8 6.5"/><path d="M6 9.8V20h12V9.8"/><path d="M10 20v-5.5h4V20"/>'),
      },
      {
        hash: '#/rating',
        label: 'Reyting',
        icon: svgWrap(
          '<path d="M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4.5A4 4 0 0 0 8.5 11"/><path d="M17 6h2.5A4 4 0 0 1 15.5 11"/><path d="M12 14v3.5"/><path d="M9 20.5h6"/>',
        ),
      },
      {
        hash: '#/channels',
        label: 'Kanallar',
        icon: svgWrap(
          '<path d="M4 10.5v3a1 1 0 0 0 1 1h2l5 3.5v-11L7 9.5H5a1 1 0 0 0-1 1Z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/>',
        ),
      },
      {
        hash: '#/profile',
        label: 'Hisob',
        icon: svgWrap('<circle cx="12" cy="8" r="3.8"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
      },
    ],
    particleCount: 5,
    particleDistances: [90, 10],
    particleR: 0,
    animationTime: 600,
    timeVariance: 0,
    colors: [1, 2, 3, 1, 2, 3, 1, 4],
    initialActiveIndex: indexForHash(location.hash || '#/home'),
    onSelect: (_index, item) => {
      TG.haptic.tap();
      go(hashFor(item.hash));
    },
  });
  (window as any).__gooeyTabs = handle;
  // Silent sync for route changes that don't come from a tab tap
  // (back button, programmatic go(), deep links).
  window.addEventListener('hashchange', () => {
    try {
      const h = (window as any).__gooeyTabs as GooeyNavHandle | undefined;
      h?.sync(location.hash || '#/home');
    } catch {}
  });
}

function indexForHash(h: string): number {
  const hash = h || '#/home';
  if (hash.startsWith('#/create')) return 0;
  if (hash === '#/home' || hash === '') return 1;
  if (hash.startsWith('#/rating') || hash.startsWith('#/trade')) return 2;
  if (hash.startsWith('#/channels')) return 3;
  if (hash.startsWith('#/profile')) return 4;
  return 1;
}

function patchViewHome() {
  const origViewHome = (window as any).viewHome;
  if (!origViewHome) {
    // Search is natively rendered in legacy viewHome — only inject for backward compat.
    // No inbox entry: join requests are approved inside the deal chat.
    const viewEl = document.getElementById('view')!;
    const obs = new MutationObserver(() => {
      if (location.hash === '#/home' || location.hash === '') {
        const view = document.getElementById('view');
        if (view && view.querySelector('.hero')) {
          if (!view.querySelector('.search-row') && !view.querySelector('.search-input')) {
            injectHomeSearch(view);
          }
          // Drop any stale inbox entry from older cached bundles
          view.querySelector('#inbox-entry')?.remove();
        }
      }
    });
    obs.observe(viewEl, { childList: true, subtree: true });
    return;
  }
}
function injectHomeSearch(view: HTMLElement) {
  const hero = view.querySelector('.hero');
  const seg = view.querySelector('.segmented');
  if (!hero || !seg) return;
  const searchRow = UI.h('div', { class: 'search-row', style: 'position:relative' }, [
    UI.icon('search', ''),
    UI.h('input', {
      class: 'search-input',
      style: 'padding-left:38px',
      placeholder: "ID, aktiv, holat bo'yicha qidirish…",
      oninput(e: any) {
        (window as any).App.state.searchQuery = e.target.value.toLowerCase().trim();
        // trigger filter re-render if App exposes renderList
        // fallback: filter visible deal cards
        filterDealCards();
      },
    }),
  ]) as HTMLElement;
  // Search glyph sits inside the input (left).
  try {
    const glyph = searchRow.querySelector('.ico') as HTMLElement | null;
    if (glyph) {
      glyph.style.cssText +=
        ';position:absolute;left:12px;top:50%;transform:translateY(-50%);opacity:.55;pointer-events:none';
    }
  } catch {}
  seg.parentNode!.insertBefore(searchRow, seg.nextSibling);
}

function filterDealCards() {
  const q = (window as any).App.state.searchQuery || '';
  const cards = document.querySelectorAll('.deal-card');
  cards.forEach((c: any) => {
    const text = (c.textContent || '').toLowerCase();
    const show = !q || text.includes(q);
    (c as HTMLElement).style.display = show ? '' : 'none';
  });
}

function patchViewCreate() {
  // Intercept create deal to inject CHANNEL/GROUP selector + username
  const viewEl = document.getElementById('view')!;
  const obs = new MutationObserver(() => {
    if (location.hash !== '#/create') return;
    const view = document.getElementById('view');
    if (!view || view.querySelector('#channel-type-wrap')) return;
    // legacy create has .segmented role + asset/amount/terms - inject after terms
    const termsLabel = Array.from(view.querySelectorAll('label')).find(
      (l) =>
        (l.textContent || '').toLowerCase().includes('terms') ||
        (l.textContent || '').toLowerCase().includes('description'),
    );
    const anchor = (termsLabel?.parentElement as HTMLElement) || (view.querySelector('.card') as HTMLElement);
    if (!anchor) return;
    const wrap = UI.h(
      'div',
      { id: 'channel-type-wrap', style: 'display:flex;flex-direction:column;gap:8px;margin-top:12px' },
      [
        UI.h('label', {
          text: "Nima savdosi? (Kanal/Guruh escrow — @gramchioka escrow holder sifatida qo'shiladi)",
          style: 'font-weight:600;font-size:13px',
        }),
        UI.h('select', { id: 'deal-type-sel', class: 'input' }, [
          UI.h('option', { value: 'P2P', text: 'P2P — narsa / xizmat (standart)' } as any),
          UI.h('option', { value: 'CHANNEL', text: 'CHANNEL — Telegram kanal (@username)' } as any),
          UI.h('option', { value: 'GROUP', text: 'GROUP — Telegram superguruh/kanal' } as any),
        ]),
        UI.h('input', {
          id: 'channel-username-input',
          class: 'input',
          placeholder: '@username yoki t.me havola (CHANNEL/GROUP uchun shart)',
          style: 'display:none',
        }) as any,
        UI.h('div', {
          id: 'channel-hint',
          class: 'field-hint',
          style: 'display:none;text-align:center',
          text: 'Sotuvchi ' + '@gramchioka' + ' ni kanalga admin qilishi shart — majburiy tekshiruv.',
        }),
      ],
    ) as HTMLElement;
    const sel = wrap.querySelector('#deal-type-sel') as HTMLSelectElement;
    const inp = wrap.querySelector('#channel-username-input') as HTMLInputElement;
    const hint = wrap.querySelector('#channel-hint') as HTMLElement;
    sel.addEventListener('change', () => {
      const v = sel.value;
      const show = v === 'CHANNEL' || v === 'GROUP';
      inp.style.display = show ? '' : 'none';
      hint.style.display = show ? '' : 'none';
      if (show) inp.focus();
    });
    anchor.parentNode!.insertBefore(wrap, anchor.nextSibling);
    // Wrap Api.createDeal to inject dealType/channelUsername from DOM
    const origCreate = (Api as any).createDeal?.bind(Api);
    if (origCreate && !(origCreate as any).__patchedChannel) {
      const wrapper = async (payload: any) => {
        try {
          const selEl = document.getElementById('deal-type-sel') as HTMLSelectElement | null;
          const inpEl = document.getElementById('channel-username-input') as HTMLInputElement | null;
          if (selEl && inpEl) {
            const dt = selEl.value;
            if (dt === 'CHANNEL' || dt === 'GROUP') {
              const uname = inpEl.value.trim();
              if (!uname) throw new Error('Channel username required for CHANNEL/GROUP');
              payload.dealType = dt;
              payload.deal_type = dt;
              payload.channelUsername = uname;
              payload.channel_username = uname;
            }
          }
        } catch {
          /* let backend validate */
        }
        return origCreate(payload);
      };
      (wrapper as any).__patchedChannel = true;
      (Api as any).createDeal = wrapper;
      // also patch legacy window.Api if present
      const wApi: any = (window as any).Api;
      if (wApi && wApi.createDeal && !(wApi.createDeal as any).__patchedChannel) {
        const wOrig = wApi.createDeal.bind(wApi);
        const wWrapper = async (payload: any) => {
          try {
            const selEl = document.getElementById('deal-type-sel') as HTMLSelectElement | null;
            const inpEl = document.getElementById('channel-username-input') as HTMLInputElement | null;
            if (selEl && inpEl) {
              const dt = selEl.value;
              if (dt === 'CHANNEL' || dt === 'GROUP') {
                const uname = inpEl.value.trim();
                if (!uname) throw new Error('Channel username required');
                payload.dealType = dt;
                payload.deal_type = dt;
                payload.channelUsername = uname;
                payload.channel_username = uname;
              }
            }
          } catch {}
          return wOrig(payload);
        };
        (wWrapper as any).__patchedChannel = true;
        wApi.createDeal = wWrapper;
      }
    }
  });
  obs.observe(viewEl, { childList: true, subtree: true });
}

function patchViewDeal() {
  const viewEl = document.getElementById('view')!;
  const obs = new MutationObserver(() => {
    const hash = location.hash || '';
    if (/^#\/deal\/\d+$/.test(hash)) {
      const view = document.getElementById('view');
      if (view && view.querySelector('.deal-head') && !view.querySelector('.webapp-bar')) {
        injectWebappBar(view, hash);
      }
      // also retarget existing confirm-bar if legacy injected
      const legacy = view?.querySelector('.confirm-bar');
      if (legacy && !view?.querySelector('.webapp-bar')) {
        try {
          (legacy as HTMLElement).style.display = 'none';
        } catch {}
        injectWebappBar(view!, hash);
      }
    }
  });
  obs.observe(viewEl, { childList: true, subtree: true });
}

async function injectWebappBar(view: HTMLElement, hash: string) {
  const m = hash.match(/^#\/deal\/(\d+)$/);
  if (!m) return;
  const id = m[1];
  let deal: any;
  try {
    deal = await Api.deal(id);
  } catch {
    return;
  }
  if (!deal) return;
  const uid = (window as any).App?.state?.meId || TG.user().id || TG.realUser?.()?.id || 0;
  const isBuyer = Number(deal.buyer_telegram_id) === Number(uid);
  const isSeller = Number(deal.seller_telegram_id) === Number(uid);
  const isParty = isBuyer || isSeller;
  if (!isParty) return;
  const actionsTitle = Array.from(view.querySelectorAll('.section-title')).find((e) =>
    e.textContent?.includes('Actions'),
  ) as HTMLElement;
  const anchor = actionsTitle || (view.querySelector('.deal-head') as HTMLElement);
  if (!anchor) return;
  // Dedupe: patchViewDeal's observer can invoke injectWebappBar twice concurrently
  // (both if-branches match, or a re-render lands mid-fetch). Each call renders at
  // most ONE bar, so a bar present at insert time means the sibling call already
  // won — without this the same banner renders twice (seen live on DEPOSIT_CONFIRMED).
  // isConnected also drops late responses after navigating to another deal.
  if (!view.isConnected) return;
  if (view.querySelector('.webapp-bar')) return;
  const st = String(deal.status || '').toUpperCase();
  const dealType = String((deal as any).deal_type || (deal as any).dealType || 'P2P').toUpperCase();
  const isChannelDeal = dealType === 'CHANNEL' || dealType === 'GROUP';
  // ── Yakuniy holatlar — har ikki tomonga toast + banner (admin qarori ham shu yerda ko'rinadi) ──
  // CLOSED is RELEASED archived by the success-close scheduler — same success copy.
  const isReleased = st === 'RELEASED' || st === 'CLOSED';
  if (isReleased || st === 'REFUNDED') {
    const doneText = isReleased ? 'Yakunlandi — bitim yopildi' : 'Qaytarildi — pul xaridorga qaytdi';
    try {
      UI.toast(doneText, 'ok');
    } catch {}
    const doneBar = UI.h('div', { class: 'banner info webapp-bar', style: 'margin:12px 0' }, [
      UI.h('div', { class: 'small', style: 'display:flex;align-items:center;gap:8px' }, [
        UI.icon(isReleased ? 'party-popper' : 'circle-check-big', 'ico-pop'),
        UI.h('span', {
          text: isReleased
            ? 'Yakunlandi — pul sotuvchiga chiqarildi. Chatda Tizim xabarini tekshiring.'
            : 'Qaytarildi — pul xaridorga qaytdi. Chatda Tizim xabarini tekshiring.',
        }),
      ]),
    ]);
    try {
      anchor.parentNode!.insertBefore(doneBar, anchor.nextSibling);
    } catch {}
    return;
  }
  // ── CHANNEL/GROUP custodial flow (via @gramchioka) — isolated, P2P below unchanged ──
  if (isChannelDeal) {
    return await renderChannelEscrow(deal, isBuyer, isSeller, uid, anchor, st);
  }
  // Always show payout input for seller when not final
  const payoutAddr = (deal as any).payout_address as string | undefined;
  const hasPayout = !!(payoutAddr && payoutAddr.trim());
  let userTon: string | null = null;
  if (isSeller) {
    try {
      const me: any = (await (Api as any).me?.()) || (await (Api as any).getMyProfile?.());
      userTon = me?.ton_address || me?.tonAddress || null;
    } catch {}
  }

  // --- Seller: DEPOSIT_CONFIRMED -> show payout + ship (ship allowed without payout per backend) ---
  if (isSeller && st === 'DEPOSIT_CONFIRMED') {
    const hasAnyPayout = hasPayout || !!userTon;
    const bar = UI.h('div', {
      class: 'webapp-bar',
      style: 'margin:12px 0;display:flex;flex-direction:column;gap:10px',
    }) as HTMLElement;
    if (!hasAnyPayout) {
      const warn = UI.h('div', { class: 'banner warn' }, [
        UI.h('div', {
          class: 'small',
          text: "TON to'lov manzilingizni kiriting — keyinroq ham saqlashingiz mumkin, lekin xaridor tasdiqlaganda to'lov shu manzilga chiqadi.",
        }),
      ]);
      bar.appendChild(warn);
    } else if (payoutAddr) {
      bar.appendChild(
        UI.h('div', { class: 'banner info' }, [
          UI.h('div', { class: 'small', text: `To'lov manzili: ${payoutAddr.slice(0, 8)}…${payoutAddr.slice(-6)}` }),
        ]),
      );
    }
    // payout input
    const input = UI.h('input', {
      class: 'input',
      placeholder: "UQ... / EQ... TON to'lov manzili",
      value: payoutAddr || userTon || '',
    }) as HTMLInputElement;
    const setBtn = UI.h('button', { class: 'btn btn-soft', text: "💾 To'lov manzilini saqlash" }) as HTMLButtonElement;
    const row = UI.h('div', { style: 'display:flex;gap:8px' }, [input, setBtn]);
    const payoutBox = UI.h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, [
      UI.h('label', { text: "Sotuvchi to'lov manzili (TON)", style: 'font-weight:600;font-size:13px' }),
      row,
      UI.h('div', {
        class: 'field-hint',
        text: "Xaridor tasdiqlaganda TON (komissiyasiz qismi) shu manzilga chiqadi. Hamyonni ulang yoki manzilni qo'lda yozing.",
      }),
    ]);
    bar.appendChild(payoutBox);
    setBtn.addEventListener('click', async () => {
      const v = input.value.trim();
      if (!v) {
        UI.toast('TON manzil kiriting', 'err');
        return;
      }
      setBtn.setAttribute('disabled', '');
      const orig = setBtn.textContent!;
      setBtn.textContent = 'Saqlanmoqda…';
      try {
        await (Api as any).payoutAddress(id, v);
        try {
          await (Api as any).setTonAddress(v);
        } catch {}
        TG.haptic.success();
        UI.toast("To'lov manzili saqlandi", 'ok');
        setTimeout(() => location.reload(), 600);
      } catch {
        TG.haptic.error();
        UI.toast("Saqlanmadi — qayta urinib ko'ring", 'err');
      } finally {
        setBtn.removeAttribute('disabled');
        setBtn.textContent = orig;
      }
    });
    // ulangan hamyon manzilini tez kiritish
    try {
      const fillBtn = UI.h('button', {
        class: 'btn btn-ghost',
        style: 'width:auto;padding:6px 10px;font-size:12px',
        text: 'Ulangan hamyondan olish',
      }) as HTMLButtonElement;
      fillBtn.addEventListener('click', async () => {
        try {
          const wAddr = (Wallet as any).addressFriendly?.() || (Wallet as any).address?.();
          if (wAddr) {
            input.value = wAddr;
            UI.toast('Hamyondan olindi', 'ok');
          } else UI.toast('Avval hamyonni ulang', 'err');
        } catch {}
      });
      row.appendChild(fillBtn);
    } catch {}
    const shipBtn = UI.h('button', { class: 'btn btn-primary' }, [
      UI.icon('badge-check', 'ico-pop'),
      ' Yetkazdim',
    ]) as HTMLButtonElement;
    const hint = UI.h('div', {
      class: 'field-hint',
      style: 'text-align:center',
      text: 'Mahsulot/xizmatni topshirgach bosing — bitim "Yuborildi" holatiga o\'tadi. Manzilni hozir yoki keyin saqlashingiz mumkin.',
    });
    bar.appendChild(shipBtn);
    bar.appendChild(hint);
    shipBtn.addEventListener('click', async () => {
      shipBtn.setAttribute('disabled', '');
      const o = shipBtn.textContent!;
      shipBtn.textContent = 'Yuborilmoqda…';
      TG.haptic.medium();
      try {
        await (Api as any).shipDeal(id);
        TG.haptic.success();
        UI.toast('Yetkazildi deb belgilandi', 'ok');
        setTimeout(() => location.reload(), 700);
      } catch (e: any) {
        TG.haptic.error();
        UI.errToast(e);
        shipBtn.removeAttribute('disabled');
        shipBtn.textContent = o;
      }
    });
    anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
    try {
      UI.toast("To'lov qabul qilindi — mahsulotni yuboring", 'ok');
    } catch {}
    return;
  }

  // --- Buyer: ITEM_SENT -> show approve ---
  if (isBuyer && st === 'ITEM_SENT') {
    const bar = UI.h('div', {
      class: 'webapp-bar',
      style: 'margin:12px 0;display:flex;flex-direction:column;gap:10px',
    }) as HTMLElement;
    bar.appendChild(
      UI.h('div', { class: 'banner info' }, [
        UI.h('div', {
          class: 'small',
          text: "📦 Sotuvchi mahsulotni yuborganini bildirdi. Qabul qilgan bo'lsangiz tasdiqlang — TON (komissiya chegirilgan) sotuvchiga chiqadi.",
        }),
      ]),
    );
    const btnRow = UI.h('div', { style: 'display:flex;gap:10px' }) as HTMLElement;
    const yesBtn = UI.h('button', { class: 'btn btn-primary' }, [
      UI.icon('circle-check-big', 'ico-pop'),
      ' Oldim — pulni chiqarish',
    ]) as HTMLButtonElement;
    const noBtn = UI.h('button', { class: 'btn btn-ghost' }, [
      UI.icon('message-circle', 'ico-wiggle'),
      ' Hali emas (chatni ochish)',
    ]) as HTMLButtonElement;
    btnRow.appendChild(yesBtn);
    btnRow.appendChild(noBtn);
    const hint = UI.h('div', {
      class: 'field-hint',
      style: 'text-align:center',
      text: "Tasdiqlasangiz escrow komissiya chegirib chiqariladi. Mahsulot kelmagan bo'lsa chatga yozing.",
    });
    bar.appendChild(btnRow);
    bar.appendChild(hint);
    yesBtn.addEventListener('click', async () => {
      yesBtn.setAttribute('disabled', '');
      const o = yesBtn.textContent!;
      yesBtn.textContent = 'Chiqarilmoqda…';
      TG.haptic.medium();
      try {
        await (Api as any).approveDeal(id);
        TG.haptic.success();
        UI.toast('Chiqarildi — yakunlandi', 'ok');
        setTimeout(() => location.reload(), 700);
      } catch (e: any) {
        TG.haptic.error();
        // Friendly guidance (deal_locked → don't double-tap, needItemSent → wait, …)
        // instead of the raw backend code.
        UI.errToast(e);
        yesBtn.removeAttribute('disabled');
        yesBtn.textContent = o;
      }
    });
    noBtn.addEventListener('click', () => {
      TG.haptic.tap();
      location.hash = '#/deal/' + id + '/chat';
    });
    anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
    try {
      UI.toast('Sotuvchi yetkazdi — qabulni tasdiqlang', 'ok');
    } catch {}
    return;
  }

  // --- Seller: ITEM_SENT awaiting buyer ---
  if (isSeller && st === 'ITEM_SENT') {
    const bar = UI.h('div', { class: 'banner info webapp-bar', style: 'margin:12px 0' }, [
      UI.h('div', {
        class: 'small',
        text: '⏳ Yuborildi deb belgiladingiz — xaridor tasdig\'i kutilmoqda. Xaridor "Oldim" ni bossa pul avtomatik chiqadi.',
      }),
    ]);
    anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
    return;
  }

  // --- Buyer: DEPOSIT_CONFIRMED waiting seller ship ---
  if (isBuyer && st === 'DEPOSIT_CONFIRMED') {
    const bar = UI.h('div', { class: 'banner info webapp-bar', style: 'margin:12px 0' }, [
      UI.h('div', {
        class: 'small',
        text: '⏳ Mablag\' tushdi — sotuvchi mahsulotni yuborishi kutilmoqda. Sotuvchi "Yetkazdim" ni bossa sizdan tasdiq so\'raladi.',
      }),
    ]);
    anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
    return;
  }

  // --- Legacy BUYER_CONFIRMED: dead state, never auto-release (P2-8) ---
  // Backend buyerApproveReceipt rejects CONFIRM_RECEIPT from here, so do NOT
  // offer an approve button — direct parties to admin review instead.
  if (st === 'BUYER_CONFIRMED' && (isBuyer || isSeller)) {
    const bar = UI.h('div', { class: 'banner info webapp-bar', style: 'margin:12px 0' }, [
      UI.h('div', {
        class: 'small',
        text: "⚠️ Bu bitim eski holatda (BUYER_CONFIRMED) — avtomatik chiqarish o'chirilgan. Admin tekshiruvi kutilmoqda: chatga yozing yoki admin bilan bog'laning.",
      }),
    ]);
    anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
    return;
  }
}

async function renderChannelEscrow(
  deal: any,
  isBuyer: boolean,
  isSeller: boolean,
  uid: number,
  anchor: HTMLElement,
  st: string,
) {
  const escrowHolder = '@gramchioka';
  const chan = String(deal.channel_username || deal.channelUsername || '').trim() || '—';
  const verified = !!deal.channel_verified;
  const escrowAt = deal.transfer_to_escrow_at;
  const payoutAddr = deal.payout_address as string | undefined;
  const pendingOwner = String(deal.pending_new_owner || '').trim();
  const bar = UI.h('div', {
    class: 'webapp-bar',
    style: 'margin:12px 0;display:flex;flex-direction:column;gap:10px',
  }) as HTMLElement;

  // 1) Seller must add @gramchioka — verify ownership
  if (!verified && isSeller) {
    bar.appendChild(
      UI.h('div', { class: 'banner info' }, [
        UI.h('div', {
          class: 'small',
          text: `📢 ${chan} kanal — ${escrowHolder} ni kanal/guruhga admin qilib qo'shing (majburiy). Keyin Tekshirish ni bosing.`,
        }),
      ]),
    );
    const verifyBtn = UI.h('button', {
      class: 'btn btn-primary',
      text: '🔍 Tekshirish — yaratuvchi men va bot adminligini tekshirish',
    }) as HTMLButtonElement;
    verifyBtn.addEventListener('click', async () => {
      verifyBtn.setAttribute('disabled', '');
      const o = verifyBtn.textContent!;
      verifyBtn.textContent = 'Tekshirilmoqda…';
      try {
        const r: any = await (Api as any).channelVerify(deal.id);
        if (r.verified) {
          TG.haptic.success();
          UI.toast('Tasdiqlandi — egasi sotuvchiga mos', 'ok');
          setTimeout(() => location.reload(), 700);
        } else {
          TG.haptic.error();
          UI.toast(
            'Mos kelmadi — siz yaratuvchi ekaningiz va ' + escrowHolder + ' adminligiga ishonch hosil qiling',
            'err',
          );
        }
      } catch (e: any) {
        TG.haptic.error();
        UI.toast("Tekshirilmadi — qayta urinib ko'ring", 'err');
      } finally {
        verifyBtn.removeAttribute('disabled');
        verifyBtn.textContent = o;
      }
    });
    bar.appendChild(verifyBtn);
    bar.appendChild(
      UI.h('div', {
        class: 'field-hint',
        style: 'text-align:center',
        text: "Ubot kanal ma'lumoti va adminlar orqali tekshiradi (yaratuvchi ekanligingiz).",
      }),
    );
    anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
    return;
  }
  if (!verified && isBuyer) {
    bar.appendChild(
      UI.h('div', { class: 'banner info' }, [
        UI.h('div', {
          class: 'small',
          text: `⏳ ${chan} kanal — sotuvchi ${escrowHolder} ni qo'shib egalikni tasdiqlashi kutilmoqda.`,
        }),
      ]),
    );
    anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
    return;
  }
  // 2) Verified — show channel card in chat hint
  if (verified) {
    bar.appendChild(
      UI.h('div', { class: 'banner info' }, [
        UI.h('div', {
          class: 'small',
          text: `✅ ${chan} kanal tasdiqlandi${deal.channel_title ? ' — ' + deal.channel_title : ''}. ${deal.channel_snapshot ? '' : ''}`,
        }),
      ]),
    );
  }
  // 3) After verification, buyer must deposit (show deposit hint while AWAITING_DEPOSIT)
  if (verified && st === 'AWAITING_DEPOSIT' && isBuyer) {
    bar.appendChild(
      UI.h('div', { class: 'banner info' }, [
        UI.h('div', {
          class: 'small',
          text: `💸 ${deal.amount} ${deal.asset} ni escrow to'lov manziliga yuboring (to'lov bo'limiga qarang). TON/USDT tushgach sotuvchidan ${escrowHolder} ga o'tkazish so'raladi.`,
        }),
      ]),
    );
    anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
    return;
  }
  if (verified && st === 'AWAITING_DEPOSIT' && isSeller) {
    bar.appendChild(
      UI.h('div', { class: 'banner info' }, [
        UI.h('div', {
          class: 'small',
          text:
            "⏳ Xaridor to'lovi kutilmoqda — mablag' tushgach " + escrowHolder + " ga o'tkazish haqida xabar beriladi.",
        }),
      ]),
    );
    anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
    return;
  }
  // 4) DEPOSIT_CONFIRMED => ask seller to transfer to escrow holder
  if (st === 'DEPOSIT_CONFIRMED' && isSeller) {
    if (!escrowAt) {
      bar.appendChild(
        UI.h('div', { class: 'banner info' }, [
          UI.h('div', {
            class: 'small',
            text: `💰 Xaridor to'ladi — endi Telegram'da ${chan} egaligini ${escrowHolder} ga o'tkazing (Kanal info → Administratorlar → Egalikni topshirish). Keyin O'tkazdim ni bosing.`,
          }),
        ]),
      );
      const reqBtn = UI.h('button', {
        class: 'btn btn-soft',
        text: `📢 ${escrowHolder} ga o'tkazaman`,
      }) as HTMLButtonElement;
      reqBtn.addEventListener('click', async () => {
        reqBtn.setAttribute('disabled', '');
        try {
          await (Api as any).channelRequestEscrow(deal.id);
          UI.toast("Qayd qilindi — hozir o'tkazing", 'ok');
        } catch (e: any) {
          UI.toast("Qayd qilinmadi — qayta urinib ko'ring", 'err');
        } finally {
          reqBtn.removeAttribute('disabled');
        }
      });
      const confBtn = UI.h('button', {
        class: 'btn btn-primary',
        text: "✅ O'tkazdim — escrow qabul qilganini tasdiqlash",
      }) as HTMLButtonElement;
      confBtn.addEventListener('click', async () => {
        confBtn.setAttribute('disabled', '');
        const o = confBtn.textContent!;
        confBtn.textContent = 'Tekshirilmoqda…';
        try {
          await (Api as any).channelConfirmEscrow(deal.id);
          TG.haptic.success();
          UI.toast("Escrow qabul qildi — endi to'lov manzilini kiriting", 'ok');
          setTimeout(() => location.reload(), 700);
        } catch (e: any) {
          TG.haptic.error();
          UI.toast('Hali emas — ' + escrowHolder + " ga o'tkazganingizga ishonch hosil qiling", 'err');
          confBtn.removeAttribute('disabled');
          confBtn.textContent = o;
        }
      });
      bar.appendChild(reqBtn);
      bar.appendChild(confBtn);
      anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
      return;
    }
  }
  if (st === 'DEPOSIT_CONFIRMED' && isBuyer) {
    const msg = escrowAt
      ? `🔒 Escrow ${chan} ni ushlab turibdi — sotuvchi to'lovi kutilmoqda.`
      : `⏳ Mablag' escrow'da — sotuvchi ${chan} ni ${escrowHolder} ga o'tkazishi kerak.`;
    bar.appendChild(UI.h('div', { class: 'banner info' }, [UI.h('div', { class: 'small', text: msg })]));
    anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
    return;
  }
  // 5) Escrow received but not yet released — ask seller payout address
  if (escrowAt && st !== 'RELEASED' && st !== 'CLOSED' && st !== 'REFUNDED' && isSeller) {
    const hasPayout = !!(payoutAddr && payoutAddr.trim());
    bar.appendChild(
      UI.h('div', { class: 'banner info' }, [
        UI.h('div', {
          class: 'small',
          text: `🔒 Escrow ${chan} ni qabul qildi — ${deal.amount} ${deal.asset} (komissiya chegirilgan) olishi uchun TON/USDT to'lov manzilini kiriting.`,
        }),
      ]),
    );
    const input = UI.h('input', {
      class: 'input',
      placeholder: 'UQ... / EQ... TON manzil',
      value: payoutAddr || '',
    }) as HTMLInputElement;
    const saveBtn = UI.h('button', { class: 'btn btn-soft', text: '💾 Manzilni saqlash' }) as HTMLButtonElement;
    saveBtn.addEventListener('click', async () => {
      const v = input.value.trim();
      if (!v) {
        UI.toast('Manzil kiriting', 'err');
        return;
      }
      saveBtn.setAttribute('disabled', '');
      try {
        await (Api as any).payoutAddress(deal.id, v);
        UI.toast("To'lov manzili saqlandi", 'ok');
      } catch (e: any) {
        UI.toast("Saqlanmadi — qayta urinib ko'ring", 'err');
      } finally {
        saveBtn.removeAttribute('disabled');
      }
    });
    const payoutBtn = UI.h('button', { class: 'btn btn-primary' }, [
      UI.icon('clock', ''),
      " To'lovni so'rash (komissiya chegiriladi)",
    ]) as HTMLButtonElement;
    payoutBtn.addEventListener('click', async () => {
      const v = input.value.trim();
      payoutBtn.setAttribute('disabled', '');
      const o = payoutBtn.textContent!;
      payoutBtn.textContent = 'Chiqarilmoqda…';
      try {
        await (Api as any).channelPayout(deal.id, v || undefined);
        TG.haptic.success();
        UI.toast("To'lov yuborildi", 'ok');
        setTimeout(() => location.reload(), 700);
      } catch (e: any) {
        TG.haptic.error();
        // escrow_custody_lost / frozen-address guidance instead of raw codes.
        UI.errToast(e);
        payoutBtn.removeAttribute('disabled');
        payoutBtn.textContent = o;
      }
    });
    const row = UI.h('div', { style: 'display:flex;gap:8px' }, [input, saveBtn]);
    bar.appendChild(row);
    bar.appendChild(payoutBtn);
    if (!hasPayout)
      bar.appendChild(
        UI.h('div', {
          class: 'field-hint',
          style: 'text-align:center',
          text: 'Hamyonni ulang yoki manzilni yozing — chiqarish uchun shart.',
        }),
      );
    anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
    return;
  }
  if (escrowAt && st !== 'RELEASED' && st !== 'CLOSED' && isBuyer) {
    bar.appendChild(
      UI.h('div', { class: 'banner info' }, [
        UI.h('div', {
          class: 'small',
          text: "⏳ Escrow kanalni ushlab turibdi — sotuvchi to'lovi kutilmoqda. Keyin yangi egani kiritasiz.",
        }),
      ]),
    );
    anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
    return;
  }
  // 6) RELEASED (or success-closed) → buyer sets new owner
  if ((st === 'RELEASED' || st === 'CLOSED') && isBuyer) {
    const already = pendingOwner;
    if (!already) {
      bar.appendChild(
        UI.h('div', { class: 'banner info' }, [
          UI.h('div', {
            class: 'small',
            text: `✅ Sotuvchiga to'landi — endi ${chan} uchun yangi ega username ni kiriting (masalan @hamroqulovv). Ubot egalikni o'tkazadi.`,
          }),
        ]),
      );
      const inp = UI.h('input', { class: 'input', placeholder: 'Yangi ega @username' }) as HTMLInputElement;
      const setBtn = UI.h('button', { class: 'btn btn-soft', text: 'Yangi egani saqlash' }) as HTMLButtonElement;
      setBtn.addEventListener('click', async () => {
        const v = inp.value.trim();
        if (!v) {
          UI.toast('@username kiriting', 'err');
          return;
        }
        setBtn.setAttribute('disabled', '');
        try {
          await (Api as any).channelSetNewOwner(deal.id, v);
          UI.toast("Saqlandi — endi O'tkazish ni bosing", 'ok');
          setTimeout(() => location.reload(), 700);
        } catch (e: any) {
          UI.toast("Saqlanmadi — qayta urinib ko'ring", 'err');
          setBtn.removeAttribute('disabled');
        }
      });
      bar.appendChild(inp);
      bar.appendChild(setBtn);
    } else {
      bar.appendChild(
        UI.h('div', { class: 'banner info' }, [
          UI.h('div', { class: 'small', text: `Yangi ega: ${already} — O'tkazish ni bosing.` }),
        ]),
      );
      const goBtn = UI.h('button', { class: 'btn btn-primary' }, [
        UI.icon('key', 'ico-tap'),
        ` ${chan} ni ${already} ga o'tkazish`,
      ]) as HTMLButtonElement;
      goBtn.addEventListener('click', async () => {
        goBtn.setAttribute('disabled', '');
        const o = goBtn.textContent!;
        goBtn.textContent = "O'tkazilmoqda…";
        try {
          await (Api as any).channelTransferToBuyer(deal.id, already);
          TG.haptic.success();
          UI.toast(already + " ga o'tkazildi", 'ok');
          setTimeout(() => location.reload(), 700);
        } catch (e: any) {
          TG.haptic.error();
          // user_not_participant / fresh_forbidden_wait_24h / custody errors
          // mapped to guidance; unknown codes still shown, never swallowed.
          UI.errToast(e);
          goBtn.removeAttribute('disabled');
          goBtn.textContent = o;
        }
      });
      bar.appendChild(goBtn);
      bar.appendChild(
        UI.h('div', {
          class: 'field-hint',
          style: 'text-align:center',
          text: "Ubot taklif qila olmasa (maxfiylik), yangi egadan avval taklif havola orqali kanalga qo'shilishini so'rang.",
        }),
      );
    }
    anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
    return;
  }
  if ((st === 'RELEASED' || st === 'CLOSED') && isSeller) {
    const dest = pendingOwner || 'xaridor tanlagan ega';
    bar.appendChild(
      UI.h('div', { class: 'banner info' }, [
        UI.h('div', {
          class: 'small',
          text: `✅ Sizga to'landi — ${chan} kanal escrow orqali ${dest} ga o'tkaziladi.`,
        }),
      ]),
    );
    anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
    return;
  }
  // fallback — show channel snapshot
  bar.appendChild(
    UI.h('div', { class: 'banner info' }, [
      UI.h('div', {
        class: 'small',
        text: `${chan} kanal — holat ${st}${verified ? ' ✓ tasdiqlangan' : ''}${escrowAt ? ' · escrow ushlab turibdi' : ''}`,
      }),
    ]),
  );
  anchor.parentNode!.insertBefore(bar, anchor.nextSibling);
  return;
}

async function injectConfirmBar(view: HTMLElement, hash: string) {
  return injectWebappBar(view, hash);
}

// Reserved for older cached bundles that may still call the legacy entrypoint.
export { injectConfirmBar as legacyInjectConfirmBar };

function wrapWalletPayForVerification() {
  const origPay = Wallet.pay.bind(Wallet);
  (Wallet as any).pay = async (to: string, amountTon: number, comment: string) => {
    const res = await origPay(to, amountTon, comment);
    // Fire-and-forget chain poll for verification — shows explorer after confirmation
    const boc = (res as any)?.boc || '';
    try {
      let tries = 0;
      const poll = async () => {
        tries++;
        try {
          const bal = await Api.balance(to).catch(() => null);
          if (bal && bal.state === 'active') {
            UI.toast('Zanjirda tasdiqlandi — balans ' + bal.balanceTon + ' TON', 'ok');
            // Optionally refresh deal view if still on detail
            if (location.hash.match(/^#\/deal\/\d+$/)) {
              // trigger soft reload via re-fetch deal
              const id = location.hash.match(/\d+/)?.[0];
              if (id) {
                const addrBtn = document.querySelector('.chain-chip') as HTMLElement;
                if (addrBtn) addrBtn.textContent = 'On-chain: verifying…';
              }
            }
            return;
          }
        } catch {}
        if (tries < 3) setTimeout(poll, 3000 + tries * 1500);
        else if (boc) {
          // show tonviewer tx link if available (tonviewer.com/transaction/<boc> not exact, but address explorer)
          UI.toast("To'lov yuborildi — tonviewer.com/" + to.slice(0, 8) + "… da ko'ring", 'ok');
        }
      };
      setTimeout(poll, 2500);
    } catch {}
    return res;
  };
}

function patchProfile() {
  const viewEl = document.getElementById('view')!;
  const obs = new MutationObserver(() => {
    if (location.hash === '#/profile') {
      const view = document.getElementById('view');
      if (view) {
        // legacy profilidagi admin qatorini topib bot-only nishon qo'yish ("Admin vositalari" matni bo'yicha)
        Array.from(view.querySelectorAll('.list-item, button, .card')).forEach((el: any) => {
          if (el.textContent && (el.textContent.includes('Admin vositalari') || el.textContent.includes('Admin'))) {
            const isAdminCard = el.textContent.includes('Admin') && el.textContent.length < 80;
            // Keep admin card but add bot-only badge instead of link
            if (isAdminCard && !el.querySelector('.admin-bot-badge')) {
              const badge = UI.h('span', {
                class: 'badge plain',
                style: 'background:var(--accent-soft);color:var(--accent);margin-left:6px',
                text: 'faqat bot',
              });
              (badge as any).className = 'admin-bot-badge badge plain';
              el.appendChild(badge);
              // disable click
              el.style.opacity = '0.7';
              el.onclick = () => UI.toast("Admin faqat bot orqali — webapp admin yo'q", 'err');
            }
          }
        });
        // Also hide any #/admin navigation buttons: override onclick
        const adminBtn = Array.from(view.querySelectorAll('button')).find((b) => b.textContent?.includes('Admin'));
        if (adminBtn)
          adminBtn.addEventListener(
            'click',
            (e) => {
              e.preventDefault();
              UI.toast('Admin boshqaruv faqat bot orqali', 'err');
            },
            true,
          );
      }
    }
  });
  obs.observe(viewEl, { childList: true, subtree: true });
}

// Global pending-request notifier — approval itself lives ONLY in the deal chat
// (inline joinRequestsBox, polling every 5-8s). This just toasts + badges so the
// creator knows which deal chat to open. No separate inbox page.
async function pollInboxBadge() {
  try {
    let rows: any[] = [];
    try {
      rows = await Api.inbox();
    } catch {
      const deals = await Api.deals().catch(() => []);
      for (const d of (deals as any[]).slice(0, 5)) {
        try {
          const reqs = await Api.joinRequests(d.id);
          reqs.forEach((r: any) => rows.push({ ...r, deal_id: (r as any).deal_id ?? d.id }));
        } catch {}
      }
    }
    const count = rows.length;
    const prev = Number((window as any).__inboxPrev || 0);
    if (count > prev && count > 0 && (window as any).__inboxInit) {
      try {
        const first = rows[0] || {};
        const did = (first as any).deal_id ?? (first as any).deal?.id;
        try {
          (TG.haptic as any)?.success?.();
        } catch {}
        UI.toast(
          did
            ? `Yangi qo'shilish so'rovi (Deal #${did}) — bitim chatini ochib tasdiqlang`
            : "Yangi qo'shilish so'rovi — bitim chatini ochib tasdiqlang",
          'ok',
        );
        // If the creator is already inside that deal chat, the inline box appears on its own poll.
      } catch {}
    }
    (window as any).__inboxPrev = count;
    (window as any).__inboxInit = true;
    // Bosh sahifa tabida inbox soni nishoni (float-nav home item, legacy .tab-btn fallback)
    let badge = document.getElementById('inbox-badge');
    if (count > 0) {
      if (!badge) {
        badge = UI.h('span', {
          class: 'badge plain',
          style: 'background:var(--accent);color:#fff;font-size:10px;padding:2px 6px;margin-left:4px',
          text: String(count),
        });
        (badge as any).id = 'inbox-badge';
        const homeBtn =
          document.querySelector('[data-tab="#/home"] span:last-child') ||
          document.querySelector('#tabbar a[href="#/home"] .float-label') ||
          document.querySelector('#tabbar .gooey-nav-container nav ul li a[href="#/home"]');
        homeBtn?.appendChild(badge);
      } else badge.textContent = String(count);
    } else if (badge) badge.remove();
  } catch {}
}

// ---------------- Channels View ----------------
function viewChannels() {
  setTabbarPatched(true);
  setTopbarPatched('Kanallar studiyasi', { back: () => navBack('#/home') });
  TG.showBack(() => navBack('#/home'));
  const view = document.getElementById('view')!;
  view.innerHTML = '';
  const rights = [
    'changeInfo',
    'postMessages',
    'editMessages',
    'deleteMessages',
    'banUsers',
    'inviteUsers',
    'pinMessages',
    'addAdmins',
    'anonymous',
    'manageCall',
    'manageTopics',
  ];
  const rightsState: Record<string, boolean> = { banUsers: true, inviteUsers: true, pinMessages: true };

  const idInput = UI.h('input', {
    class: 'input',
    placeholder: '@username yoki -100… yoki kanal ID',
    type: 'text',
  }) as HTMLInputElement;
  const statusEl = UI.h('div', {
    class: 'small muted',
    style: 'margin-top:8px',
    text: '@username, raqamli ID yoki t.me havola kiriting',
  });
  const resultBox = UI.h('div', { style: 'margin-top:16px' });

  const renderRights = () => {
    const grid = UI.h('div', { class: 'rights-grid' });
    rights.forEach((r) => {
      const checked = !!rightsState[r];
      const item = UI.h('label', { class: 'rights-item' }, [
        UI.h('input', {
          type: 'checkbox',
          checked: checked ? '' : null,
          onchange(e: any) {
            rightsState[r] = e.target.checked;
          },
        } as any),
        UI.h('span', { text: r }),
      ]);
      grid.appendChild(item);
    });
    return grid;
  };
  const rightsGrid = renderRights();

  const adminListBox = UI.h('div', { style: 'margin-top:12px' });
  const actionRow = UI.h('div', { class: 'btn-row', style: 'flex-wrap:wrap' });

  async function loadInfo() {
    const raw = idInput.value.trim();
    if (!raw) {
      UI.toast('Kanal ID kiriting', 'err');
      return;
    }
    let cid = raw;
    // normalize @ -> strip, t.me link -> username
    if (cid.startsWith('https://t.me/') || cid.startsWith('t.me/')) {
      try {
        const u = new URL(cid.startsWith('http') ? cid : 'https://' + cid);
        cid = '@' + u.pathname.split('/')[1];
      } catch {}
    }
    statusEl.textContent = 'Yuklanmoqda…';
    resultBox.innerHTML = '';
    adminListBox.innerHTML = '';
    actionRow.innerHTML = '';
    try {
      const info = await Api.ubot.info(cid);
      statusEl.textContent = 'Kanal topildi';
      const card = UI.h('div', { class: 'studio-card' }, [
        UI.h('div', { class: 'studio-head' }, [
          UI.h('div', { class: 'li-icon', text: '📢' }),
          UI.h('div', {}, [
            UI.h('b', { text: info.title || cid }),
            UI.h('span', { text: `ID ${info.id || cid} · ${info.participants_count || '—'} a'zo` }),
          ]),
        ]),
        UI.h('div', { class: 'small muted', text: info.username ? '@' + info.username : cid }),
      ]);
      resultBox.appendChild(card);

      // Admins
      try {
        const admins = await Api.ubot.admins(cid);
        const list = Array.isArray(admins) ? admins : admins.admins || [];
        adminListBox.appendChild(UI.h('div', { class: 'section-title', text: `Adminlar (${list.length})` }));
        list.slice(0, 10).forEach((a: any) => {
          adminListBox.appendChild(
            UI.h('div', { class: 'studio-card', style: 'padding:10px;display:flex;justify-content:space-between' }, [
              UI.h('span', { text: `${a.user?.first_name || a.user?.username || 'ID ' + a.userId}` }),
              UI.h('span', { class: 'small muted', text: a.rank || '' }),
            ]),
          );
        });
      } catch {}

      // Actions
      const userIdInput = UI.h('input', {
        class: 'input',
        placeholder: 'Maqsad Telegram ID (raqamli)',
        type: 'text',
        inputmode: 'numeric',
      }) as HTMLInputElement;
      const rankInput = UI.h('input', {
        class: 'input',
        placeholder: 'Unvon (ixtiyoriy, ≤32 belgi)',
        maxlength: '32',
      }) as HTMLInputElement;
      actionRow.appendChild(
        UI.h('div', { class: 'field', style: 'width:100%' }, [
          UI.h('label', { text: 'Maqsad foydalanuvchi ID' }),
          userIdInput,
        ]),
      );
      actionRow.appendChild(
        UI.h('div', { class: 'field', style: 'width:100%' }, [UI.h('label', { text: 'Unvon' }), rankInput]),
      );
      actionRow.appendChild(rightsGrid);

      const mkBtn = (label: string, cls: string, fn: (uid: string, rank: string) => Promise<any>) =>
        UI.h(
          'button',
          {
            class: 'btn ' + cls,
            onclick: async (e: any) => {
              const uid = userIdInput.value.trim();
              if (!uid || !/^\d+$/.test(uid)) {
                UI.toast('Raqamli Telegram ID kiriting', 'err');
                return;
              }
              const rank = rankInput.value.trim();
              const btn = e.currentTarget as HTMLButtonElement;
              const orig = btn.textContent;
              btn.setAttribute('disabled', '');
              btn.textContent = 'Bajarilmoqda…';
              try {
                await fn(uid, rank);
                TG.haptic.success();
                UI.toast(label + ' bajarildi', 'ok');
              } catch (err: any) {
                TG.haptic.error();
                UI.errToast(err);
              } finally {
                btn.removeAttribute('disabled');
                if (orig) btn.textContent = orig;
              }
            },
          },
          [label],
        );

      const btnRow2 = UI.h('div', { class: 'btn-row' }, [
        mkBtn('Admin qilish', 'btn-soft', (uid, rank) =>
          Api.ubot.promote(cid, { userId: Number(uid), rights: rightsState, rank }),
        ),
        mkBtn('Taklif qilish', 'btn-ghost', (uid) => Api.ubot.invite(cid, { userId: Number(uid) })),
      ]);
      const btnRow3 = UI.h('div', { class: 'btn-row' }, [
        mkBtn('Adminlikdan olish', 'btn-ghost', async (uid) =>
          Api.ubot.promote(cid, { userId: Number(uid), rights: {}, rank: '' }),
        ),
      ]);
      const transferBtn = UI.h(
        'button',
        {
          class: 'btn btn-primary',
          onclick: async (e: any) => {
            const uid = userIdInput.value.trim();
            if (!uid) {
              UI.toast('Maqsad ID kiriting', 'err');
              return;
            }
            const pw =
              prompt(
                "Egalikni topshirish 2FA parol talab qiladi (agar yoqilgan bo'lsa) — kiriting yoki bo'sh qoldiring:",
              ) || undefined;
            const btn = e.currentTarget as HTMLButtonElement;
            btn.setAttribute('disabled', '');
            const orig = btn.textContent;
            btn.textContent = "O'tkazilmoqda…";
            try {
              await Api.ubot.transfer(cid, { newOwnerId: Number(uid), password: pw });
              TG.haptic.success();
              UI.toast("O'tkazildi", 'ok');
            } catch (err: any) {
              TG.haptic.error();
              UI.errToast(err);
            } finally {
              btn.removeAttribute('disabled');
              btn.textContent = orig!;
            }
          },
        },
        ['Egalikni topshirish'],
      );
      const takeoverBtn = UI.h(
        'button',
        {
          class: 'btn btn-primary',
          style: 'background:var(--accent-grad);margin-top:8px',
          onclick: async (e: any) => {
            const uid = userIdInput.value.trim();
            if (!uid) {
              UI.toast('Yangi ega ID kiriting', 'err');
              return;
            }
            const rank = rankInput.value.trim();
            const btn = e.currentTarget as HTMLButtonElement;
            btn.setAttribute('disabled', '');
            const orig = btn.textContent;
            btn.textContent = 'Egallanmoqda… (admin→topshirish)';
            try {
              await Api.ubot.takeover(cid, { newOwnerId: Number(uid), rights: rightsState, rank });
              TG.haptic.success();
              UI.toast('Egallandi', 'ok');
            } catch (err: any) {
              TG.haptic.error();
              UI.errToast(err);
            } finally {
              btn.removeAttribute('disabled');
              btn.textContent = orig!;
            }
          },
        },
        ['⚡ Egallash (bir bosishda)'],
      );

      resultBox.appendChild(
        UI.h('div', { style: 'margin-top:12px' }, [
          userIdInput.parentElement!,
          rankInput.parentElement!,
          rightsGrid,
          btnRow2,
          btnRow3,
          transferBtn,
          takeoverBtn,
        ]),
      );
      resultBox.appendChild(
        UI.h('div', { class: 'banner info', style: 'margin-top:12px' }, [
          UI.h('div', {
            class: 'small',
            text: 'Egallash = admin qilish (1.2-2.2s insoniy kechikish) → 2.5s → SRP 2FA orqali topshirish. 24 soatlik FRESH_CHANGE_ADMINS_FORBIDDEN himoyasi va 1.3s global limit hisobga olinadi.',
          }),
        ]),
      );
    } catch (e: any) {
      statusEl.textContent = '';
      UI.toast(e.message || 'Kanal topilmadi', 'err');
      resultBox.appendChild(
        UI.h('div', { class: 'banner error' }, [
          UI.h('div', { class: 'small', text: e.message || 'Topilmadi yoki admin emassiz' }),
        ]),
      );
    }
  }

  const searchBtn = UI.h('button', { class: 'btn btn-primary', onclick: loadInfo }, ['Kanalni yuklash']);
  const groupBox = UI.h('div', { class: 'card', style: 'margin-top:16px' }, [
    UI.h('b', { text: "Guruhlar — oddiy → superguruhga o'tkazish" }),
    UI.h('p', {
      class: 'small muted',
      style: 'margin-top:4px',
      text: "Oddiy guruhlarni admin topshirishdan oldin ko'chirish kerak. Guruh ID kiritib tekshiring.",
    }),
    UI.h('div', { class: 'search-row' }, [
      UI.h('input', { class: 'input', placeholder: 'Guruh ID yoki @username', id: 'group-id' } as any),
      UI.h(
        'button',
        {
          class: 'btn btn-soft',
          style: 'width:auto;padding:10px 14px',
          onclick: async () => {
            const inp = document.getElementById('group-id') as HTMLInputElement;
            const gid = inp?.value.trim();
            if (!gid) {
              UI.toast('Guruh ID kiriting', 'err');
              return;
            }
            try {
              const r: any = await Api.ubot.groupIsBasic(gid);
              if (r.isBasic) {
                UI.toast("Oddiy guruh — ko'chirilmoqda…", 'ok');
                const m: any = await Api.ubot.groupMigrate(gid);
                UI.toast("Ko'chirildi → kanal ID " + (m.channelId || m.id), 'ok');
              } else UI.toast('Allaqachon superguruh', 'ok');
            } catch (err: any) {
              UI.toast(err.message || "Ko'chirilmadi", 'err');
            }
          },
        },
        ["Ko'chirish"],
      ),
    ]),
  ]);

  const root = UI.h('div', {}, [
    UI.h('div', { class: 'hero' }, [
      UI.h('h1', { text: 'Kanallar studiyasi' }),
      UI.h('p', { style: 'display:flex;align-items:center;gap:8px' }, [
        UI.icon('lock-keyhole', ''),
        UI.h('span', {
          text: "Kanallar va guruhlarni egallash — shifrlangan ubot orqali admin qilish, taklif qilish, egalikni o'tkazish.",
        }),
      ]),
    ]),
    UI.h('div', { class: 'card' }, [
      UI.h('label', { text: 'Kanal / Guruh' }),
      idInput,
      UI.h('div', { style: 'height:8px' }),
      searchBtn,
      statusEl,
    ]),
    resultBox,
    adminListBox,
    actionRow,
    groupBox,
  ]);
  view.appendChild(root);
}

// ---------------- Rating View ----------------
// Monthly buyer leaderboard: RELEASED deals only, buyer side earns.
// Window = current calendar month by completion time.
const UZ_MONTHS = [
  'Yanvar',
  'Fevral',
  'Mart',
  'Aprel',
  'May',
  'Iyun',
  'Iyul',
  'Avgust',
  'Sentabr',
  'Oktabr',
  'Noyabr',
  'Dekabr',
];
const RATING_MEDALS = ['🥇', '🥈', '🥉'];

function uzMonthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  if (!m) return 'Shu oy';
  const mi = Math.max(1, Math.min(12, parseInt(m[2], 10))) - 1;
  return UZ_MONTHS[mi] + ' ' + m[1];
}

function ratingName(r: any): string {
  const u = String(r.username || '')
    .trim()
    .replace(/^@/, '');
  if (u) return '@' + u;
  return 'ID ' + r.telegram_id;
}

function viewRating() {
  setTabbarPatched(true);
  setTopbarPatched('Reyting', { back: () => navBack('#/home') });
  TG.showBack(() => navBack('#/home'));
  const view = document.getElementById('view')!;
  view.innerHTML = '';
  let asset: 'TON' | 'USDT' = 'TON';
  const App = (window as any).App;
  const meId = Number(App?.state?.meId || 0);

  const tabs = UI.h('div', { class: 'trade-tabs', role: 'tablist' }, [
    UI.h(
      'button',
      {
        class: 'active',
        onclick() {
          asset = 'TON';
          update();
          (tabs.children[0] as any).classList.add('active');
          (tabs.children[1] as any).classList.remove('active');
        },
      },
      ['TON'],
    ),
    UI.h(
      'button',
      {
        onclick() {
          asset = 'USDT';
          update();
          (tabs.children[1] as any).classList.add('active');
          (tabs.children[0] as any).classList.remove('active');
        },
      },
      ['USDT'],
    ),
  ]);
  const sub = UI.h('p', { text: 'Oylik savdo hajmi — faqat yakunlangan bitimlar.' });
  const body = UI.h('div', {});

  function update() {
    body.innerHTML = '';
    body.appendChild(UI.h('div', { class: 'sk', style: 'height:72px;border-radius:18px' }));
    Api.rating(asset)
      .then((res) => {
        sub.textContent =
          uzMonthLabel(res.month) + ' — yakunlangan bitimlar hajmi. Ochko faqat TON/USDT yuborgan xaridorga yoziladi.';
        renderRows(res.rows || []);
      })
      .catch((e: any) => {
        body.innerHTML = '';
        body.appendChild(
          UI.h('div', { class: 'banner error' }, [
            UI.h('div', { class: 'small', text: e.message || 'Reyting yuklanmadi' }),
          ]),
        );
        body.appendChild(
          UI.h('div', { class: 'btn-row' }, [
            UI.h('button', { class: 'btn btn-soft', onclick: () => update() }, ['Qayta urinish']),
          ]),
        );
      });
  }

  function renderRows(rows: any[]) {
    body.innerHTML = '';
    if (!rows.length) {
      body.appendChild(
        UI.h('div', { class: 'empty' }, [
          UI.h('div', { class: 'art', text: '🏆' }),
          UI.h('h3', { text: 'Hali reyting yo‘q' }),
          UI.h('p', { text: 'Bu oyda yakunlangan ' + asset + ' bitim topilmadi. Birinchi bo‘ling!' }),
        ]),
      );
      return;
    }
    rows.forEach((r: any, i: number) => {
      const isMe = meId > 0 && Number(r.telegram_id) === meId;
      const rank = i < RATING_MEDALS.length ? RATING_MEDALS[i] : '#' + (i + 1);
      body.appendChild(
        UI.h(
          'div',
          {
            class: 'deal-card',
            style: isMe ? 'border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)' : null,
          },
          [
            UI.h('div', { class: 'deal-top' }, [
              UI.h('div', {
                class: 'asset-glyph ' + (i === 0 ? 'asset-ton' : i === 1 ? 'asset-usdt' : 'asset-any'),
                text: rank,
              }),
              UI.h('div', {}, [
                UI.h('div', { class: 'deal-title', text: ratingName(r) }),
                UI.h('div', { class: 'deal-sub', text: r.deals + ' bitim' + (isMe ? ' · Siz' : '') }),
              ]),
              UI.h('div', { class: 'deal-amt' }, [UI.h('b', { text: UI.fmtAmount(r.volume) + ' ' + asset })]),
            ]),
          ],
        ),
      );
    });
  }

  const root = UI.h('div', {}, [
    UI.h('div', { class: 'hero' }, [UI.h('h1', { text: 'Reyting' }), sub]),
    tabs,
    UI.h('div', { style: 'height:12px' }),
    body,
  ]);
  view.appendChild(root);
  update();
}
