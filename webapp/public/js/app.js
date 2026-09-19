/* app.js — Savdochi Mini App: router, views, controllers */
(function () {
  'use strict';
  var TG = window.TG;
  var Api = window.Api;
  var UI = window.UI;
  var ChatCrypto = window.ChatCrypto;
  var Wallet = window.Wallet;

  var App = {
    state: {
      user: null,
      meId: 0,
      admins: [],
      deals: [],
      filter: 'active',
      apiOk: null,
      createdLinks: {},
    },
    navStack: [],
    currentHash: null,
    _navBack: false,
    cleanupFns: [],
    backHandler: null,
    actionHandler: null,
    wz: null,
    chatTimer: null,
  };

  /* ================= Router ================= */

  var ROUTES = [
    { re: /^#\/home$/, fn: viewHome },
    { re: /^#\/create$/, fn: viewCreate },
    { re: /^#\/deal\/(\d+)\/join\/([A-Za-z0-9_\-]+)$/, fn: viewJoin },
    { re: /^#\/deal\/(\d+)\/chat$/, fn: viewChat },
    { re: /^#\/deal\/(\d+)$/, fn: viewDeal },
    { re: /^#\/profile$/, fn: viewProfile },
    { re: /^#\/admin$/, fn: viewAdmin },
    {
      re: /^#\/inbox$/,
      fn: function () {
        return window.__viewInbox && window.__viewInbox();
      },
    },
    {
      re: /^#\/trade$/,
      fn: function () {
        return window.__viewTrade && window.__viewTrade();
      },
    },
    {
      re: /^#\/channels$/,
      fn: function () {
        return window.__viewChannels && window.__viewChannels();
      },
    },
  ];

  function cleanup() {
    App.cleanupFns.forEach(function (fn) {
      try {
        fn();
      } catch (e) {}
    });
    App.cleanupFns = [];
    if (App.chatTimer) {
      clearInterval(App.chatTimer);
      App.chatTimer = null;
    }
    TG.main.hide();
    TG.hideBack();
    UI.sheetClose();
  }

  function router() {
    cleanup();
    App.backHandler = null;
    App.actionHandler = null;

    var hash = location.hash || '#/home';
    if (App._navBack) {
      App._navBack = false;
      App.navStack.pop();
    } else if (App.currentHash && App.currentHash !== hash) App.navStack.push(App.currentHash);
    if (App.navStack.length > 25) App.navStack.shift();
    App.currentHash = hash;

    var matched = null,
      m = null;
    for (var i = 0; i < ROUTES.length; i++) {
      m = hash.match(ROUTES[i].re);
      if (m) {
        matched = ROUTES[i];
        break;
      }
    }

    var root = document.getElementById('view');
    root.classList.remove('view-enter');
    void root.offsetWidth;

    if (!matched) {
      location.hash = '#/home';
      return;
    }
    matched.fn.apply(null, m.slice(1));
    root.classList.add('view-enter');
    root.scrollTop = 0;
  }

  function go(hash) {
    if (location.hash === hash) router();
    else location.hash = hash;
  }

  function navBack(fallbackHash) {
    var prev = App.navStack.length ? App.navStack[App.navStack.length - 1] : null;
    if (prev && prev !== (location.hash || '#/home')) {
      App._navBack = true;
      go(prev);
    } else go(fallbackHash || '#/home');
  }

  /* ================= Chrome (topbar / tabs) ================= */

  function setTopbar(title, opts) {
    opts = opts || {};
    document.getElementById('tb-title').textContent = title;

    var backBtn = document.getElementById('tb-back');
    var actBtn = document.getElementById('tb-action');

    if (opts.back) {
      backBtn.classList.remove('hidden');
      App.backHandler = opts.back;
    } else {
      backBtn.classList.add('hidden');
      App.backHandler = null;
    }

    if (opts.action) {
      actBtn.classList.remove('hidden', 'spin');
      actBtn.innerHTML = opts.action.icon;
      App.actionHandler = opts.action.handler;
    } else {
      actBtn.classList.add('hidden');
      App.actionHandler = null;
    }
  }

  function setTabbar(visible) {
    document.getElementById('tabbar').classList.toggle('hidden', !visible);
    document.getElementById('view').classList.toggle('no-tabbar', !visible);
  }

  function bindChrome() {
    document.getElementById('tb-back').addEventListener('click', function () {
      TG.haptic.light();
      if (App.backHandler) App.backHandler();
    });
    document.getElementById('tb-action').addEventListener('click', function () {
      TG.haptic.tap();
      if (App.actionHandler) App.actionHandler();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), function (btn) {
      btn.addEventListener('click', function () {
        TG.haptic.tap();
        go(btn.getAttribute('data-tab'));
      });
    });
  }

  var ICON_REFRESH =
    '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M17.65 6.35A8 8 0 1 0 19.7 14h-2.08a6 6 0 1 1-1.39-6.23L13 11h7V4z"/></svg>';

  /* ================= Shared components ================= */

  function dealCard(deal) {
    var am = UI.assetMeta(deal.asset);
    var sm = UI.statusMeta(deal.status);
    var uid = App.state.meId;
    var iAmBuyer = Number(deal.buyer_telegram_id) === uid;
    var otherRole = iAmBuyer ? 'Sotuvchi' : 'Xaridor';
    var otherId = iAmBuyer ? deal.seller_telegram_id : deal.buyer_telegram_id;
    var sub = otherId
      ? otherRole + ' · ID ' + otherId
      : (deal.buyer_telegram_id ? 'Xaridor ' + deal.buyer_telegram_id : 'Ochiq bitim') +
        (deal.seller_telegram_id ? ' · Sotuvchi ' + deal.seller_telegram_id : '');

    return UI.h(
      'button',
      {
        class: 'deal-card',
        onclick: function () {
          TG.haptic.light();
          go('#/deal/' + deal.id);
        },
      },
      [
        UI.h('div', { class: 'row' }, [
          UI.h('div', { class: 'asset-glyph ' + am.cls, text: am.glyph }),
          UI.h('div', {}, [
            UI.h('div', { class: 'deal-title', text: 'Bitim #' + deal.id }),
            UI.h('div', { class: 'deal-sub', text: sub }),
          ]),
          UI.h('div', { class: 'deal-amt' }, [
            UI.h('b', { text: UI.fmtAmount(deal.amount) + ' ' + am.symbol }),
            UI.h('div', {}, [UI.h('span', { class: 'badge ' + sm.cls, text: sm.label, style: 'margin-top:5px' })]),
          ]),
        ]),
      ],
    );
  }

  function emptyState(art, title, text, ctaText, ctaHash) {
    var box = UI.h('div', { class: 'empty' }, [
      UI.h('div', { class: 'art', text: art }),
      UI.h('h3', { text: title }),
      UI.h('p', { text: text }),
    ]);
    if (ctaText) {
      box.appendChild(
        UI.h(
          'button',
          {
            class: 'btn btn-primary',
            onclick: function () {
              go(ctaHash || '#/create');
            },
          },
          [ctaText],
        ),
      );
    }
    return box;
  }

  function errorBox(message, retry) {
    return UI.h('div', { class: 'banner error' }, [
      UI.h('div', { style: 'flex:1' }, [
        UI.h('div', { style: 'font-weight:700;margin-bottom:2px', text: "Serverga ulanib bo'lmadi" }),
        UI.h('div', { class: 'small', text: message }),
      ]),
      retry ? UI.h('button', { class: 'link-btn', onclick: retry, text: 'Qayta urinish' }) : null,
    ]);
  }

  /* ================= Wallet ================= */

  function walletPill() {
    var balEl = UI.h('span', { class: 'wallet-bal small muted', style: 'margin-left:8px', text: '' });
    var btn = UI.h(
      'button',
      {
        class: 'wallet-pill',
        onclick: function () {
          TG.haptic.tap();
          if (!Wallet.available()) {
            UI.toast('Hamyon SDK yuklanmoqda…');
            return;
          }
          if (Wallet.connected()) walletSheet();
          else
            Wallet.connect().catch(function (err) {
              console.warn('[App] connect failed', err);
              UI.toast(err && err.message ? err.message : 'Hamyon ulanmadi', 'err');
            });
        },
      },
      ['🔌 Hamyonni ulash'],
    );
    var wrap = UI.h('div', { class: 'wallet-pill-wrap', style: 'display:flex;align-items:center' }, [btn, balEl]);

    var render = function (acc) {
      // acc may be passed from onStatus, else use Wallet
      var isConn = Wallet.connected();
      var addr = Wallet.address();
      // If onStatus gave us acc directly, prefer it
      if (acc && acc.address) {
        isConn = true;
        addr = acc.address;
      }
      if (isConn && addr) {
        var friendly = Wallet.addressFriendly ? Wallet.addressFriendly() : UI.toFriendly ? UI.toFriendly(addr) : addr;
        btn.textContent = '👛 ' + UI.shortAddr(friendly);
        btn.classList.add('connected');
        // Fetch balance async
        balEl.textContent = '…';
        Wallet.getBalance()
          .then(function (r) {
            var ton = r.balanceTon || (Number(r.balance) / 1e9).toString();
            var n = Number(ton);
            balEl.textContent = isFinite(n) ? n.toFixed(4).replace(/\.?0+$/, '') + ' TON' : ton + ' TON';
          })
          .catch(function (err) {
            console.warn('[App] balance fetch failed', err);
            balEl.textContent = '';
          });
      } else {
        btn.textContent = '🔌 Hamyonni ulash';
        btn.classList.remove('connected');
        balEl.textContent = '';
      }
    };

    // Immediate + subscribed rendering
    Wallet.whenReady()
      .then(function () {
        render();
      })
      .catch(function () {
        render();
      });
    Wallet.onStatus(function (acc) {
      render(acc);
    });
    // Fallback poll until wallet ready (covers slow SDK)
    var iv = setInterval(function () {
      if (Wallet.connected()) {
        render();
        clearInterval(iv);
      }
    }, 1000);
    setTimeout(function () {
      clearInterval(iv);
    }, 10000);
    // Initial render
    render();
    return wrap;
  }

  function walletSheet() {
    var raw = Wallet.address();
    if (!raw) {
      UI.toast('Hamyon ulanmagan', 'err');
      return;
    }
    var friendly = Wallet.addressFriendly ? Wallet.addressFriendly() : UI.toFriendly(raw);
    var chain = Wallet.chain ? Wallet.chain() : null;
    var chainLabel = chain === -239 ? 'Mainnet' : chain === -3 ? 'Testnet' : chain != null ? 'Chain ' + chain : '';
    var balRow = UI.h('div', {
      class: 'field-hint',
      style: 'margin:8px 0;font-size:13px',
      text: 'Balans: yuklanmoqda…',
    });
    // Fetch balance
    Wallet.getBalance()
      .then(function (r) {
        var ton = r.balanceTon || (Number(r.balance) / 1e9).toString();
        balRow.textContent =
          'Balans: ' + ton + ' TON' + (r.state ? ' · ' + r.state : '') + (chainLabel ? ' · ' + chainLabel : '');
      })
      .catch(function (err) {
        balRow.textContent = 'Balans: mavjud emas' + (chainLabel ? ' · ' + chainLabel : '');
        console.warn('[App] walletSheet balance failed', err);
      });

    var content = UI.h('div', {}, [
      UI.h('h3', { text: 'Hamyoningiz' }),
      UI.h('p', {
        class: 'sub',
        text:
          (Wallet.walletName() || 'Ulangan') +
          (chainLabel ? ' · ' + chainLabel : '') +
          ' · nusxalash uchun manzilni bosing',
      }),
      UI.h(
        'button',
        {
          class: 'addr-pill',
          style: 'margin-bottom:8px',
          onclick: function () {
            UI.copy(friendly, 'Hamyon manzili nusxalandi');
          },
        },
        [
          UI.h('span', { class: 'mono', text: UI.truncate(friendly, 10, 8) }),
          UI.h('span', { class: 'small muted', text: 'nusxa' }),
        ],
      ),
      UI.h('div', { class: 'addr-pill', style: 'margin-bottom:8px;opacity:.7' }, [
        UI.h('span', { class: 'mono small', text: UI.truncate(raw, 12, 8) }),
        UI.h('span', { class: 'small muted', text: 'xom' }),
      ]),
      balRow,
      UI.h(
        'button',
        {
          class: 'btn btn-danger',
          onclick: function () {
            TG.haptic.medium();
            Wallet.disconnect().then(function () {
              UI.sheetClose();
              UI.toast('Hamyon uzildi');
            });
          },
        },
        ['Uzish'],
      ),
    ]);
    UI.sheetOpen(content);
  }

  /* ================= Home ================= */

  function viewHome() {
    setTabbar(true);
    setTopbar('Savdochi');

    var s = App.state;
    var name = (s.user && (s.user.first_name || s.user.username)) || 'there';

    var seg = UI.h('div', { class: 'segmented' }, [
      segBtn('active', 'Faol'),
      segBtn('done', 'Yakunlangan'),
      segBtn('all', 'Barchasi'),
    ]);

    var stats = UI.h('div', { class: 'stats-grid' });
    var listBox = UI.h('div', { class: 'deal-list' });

    var root = UI.h(
      'div',
      {},
      [
        !TG.realUser()
          ? UI.h('div', { class: 'banner info' }, [
              UI.h(
                'div',
                {},
                UI.h('div', {
                  class: 'small',
                  text: "Ko'rib chiqish rejimi — to'liq ishlashi uchun sahifani Telegram ichida oching.",
                }),
              ),
            ])
          : null,
        UI.h('div', { class: 'hero' }, [
          UI.h('h1', { text: 'Salom, ' + name + ' 👋' }),
          UI.h('p', { text: "Mablag'ni escrow'da bloklang va ishonchli P2P savdo qiling." }),
          UI.h('div', { class: 'row', style: 'margin-top:12px' }, [walletPill()]),
        ]),
        stats,
        seg,
        listBox,
      ].filter(Boolean),
    );

    function segBtn(key, label) {
      return UI.h(
        'button',
        {
          class: App.state.filter === key ? 'active' : '',
          onclick: function () {
            TG.haptic.tap();
            App.state.filter = key;
            Array.prototype.forEach.call(seg.children, function (b) {
              b.classList.remove('active');
            });
            seg.children[['active', 'done', 'all'].indexOf(key)].classList.add('active');
            renderList();
          },
        },
        [label],
      );
    }

    function computeStats(deals) {
      var active = 0,
        done = 0,
        volume = 0;
      deals.forEach(function (d) {
        var u = String(d.status || '').toUpperCase();
        if (u === 'RELEASED' || u === 'REFUNDED') done++;
        else {
          active++;
          if (u === 'DEPOSIT_CONFIRMED' || u === 'BUYER_CONFIRMED') volume += Number(d.amount) || 0;
        }
      });
      stats.innerHTML = '';
      [
        [done + active, 'Jami'],
        [active, 'Jarayonda'],
        [done, 'Yakunlangan'],
      ].forEach(function (p) {
        stats.appendChild(
          UI.h('div', { class: 'stat' }, [UI.h('b', { text: String(p[0]) }), UI.h('span', { text: p[1] })]),
        );
      });
    }

    function matchesFilter(d) {
      var u = String(d.status || '').toUpperCase();
      var f = App.state.filter;
      if (f === 'all') return true;
      if (f === 'done') return u === 'RELEASED' || u === 'REFUNDED';
      return u !== 'RELEASED' && u !== 'REFUNDED';
    }

    function renderList() {
      listBox.innerHTML = '';
      var visible = App.state.deals.filter(matchesFilter);
      if (!visible.length) {
        listBox.appendChild(
          emptyState(
            '🛡️',
            App.state.filter === 'active' ? "Faol bitimlar yo'q" : "Hozircha bo'sh",
            "Xavfsiz P2P bitim boshlang — mablag' hamma tasdiqlamaguncha escrow'da bloklanadi.",
            '+ Yangi bitim',
          ),
        );
        return;
      }
      visible.forEach(function (d) {
        listBox.appendChild(dealCard(d));
      });
    }

    function load(silent) {
      if (!silent) {
        listBox.innerHTML = '';
        listBox.appendChild(UI.skeletonDeals(4));
      }
      return Api.deals()
        .then(function (deals) {
          App.state.apiOk = true;
          App.state.deals = deals;
          computeStats(deals);
          renderList();
        })
        .catch(function (err) {
          listBox.innerHTML = '';
          if (err && (err.status === 401 || err.status === 403)) {
            // Private listing — anonymous or not-a-party sees nothing
            if (!TG.realUser()) {
              listBox.appendChild(
                UI.h('div', { class: 'banner warn' }, [
                  UI.h('div', {
                    class: 'small',
                    text: "Bitimlaringizni ko'rish uchun Mini App'ni Telegram ichida oching. Bitimlar faqat xaridor va sotuvchiga ko'rinadi.",
                  }),
                ]),
              );
              listBox.appendChild(
                emptyState(
                  '🔒',
                  "Ko'rsatadigan bitimlar yo'q",
                  "Bitimlaringiz maxfiy — faqat siz va sherigingiz ko'radi. Yangi bitim yarating yoki taklif havolasi orqali qo'shiling.",
                  '+ Yangi bitim',
                ),
              );
            } else {
              App.state.apiOk = true;
              App.state.deals = [];
              computeStats([]);
              renderList();
            }
          } else {
            listBox.appendChild(
              errorBox(err.message || String(err), function () {
                load(false);
              }),
            );
          }
        });
    }

    document.getElementById('view').innerHTML = '';
    document.getElementById('view').appendChild(root);
    load(false);

    setTopbar('Savdochi');

    var t = setInterval(function () {
      load(true);
    }, 20000);
    App.cleanupFns.push(function () {
      clearInterval(t);
    });
  }

  /* ================= Create deal wizard ================= */

  var DEADLINE_OPTIONS = [
    { h: 24, label: '24 soat' },
    { h: 48, label: '48 soat' },
    { h: 72, label: '3 kun' },
    { h: 168, label: '7 kun' },
  ];

  // Idempotency key: one per wizard session. Retries reuse the SAME key so a
  // timeout retry can never mint a second deal (backend dedups on it).
  function genClientRequestId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
      var rb = new Uint8Array(16);
      window.crypto.getRandomValues(rb);
      rb[6] = (rb[6] & 0x0f) | 0x40;
      rb[8] = (rb[8] & 0x3f) | 0x80;
      var hx = function (i) {
        return ('0' + rb[i].toString(16)).slice(-2);
      };
      return (
        hx(0) +
        hx(1) +
        hx(2) +
        hx(3) +
        '-' +
        hx(4) +
        hx(5) +
        '-' +
        hx(6) +
        hx(7) +
        '-' +
        hx(8) +
        hx(9) +
        '-' +
        hx(10) +
        hx(11) +
        hx(12) +
        hx(13) +
        hx(14) +
        hx(15)
      );
    } catch (e) {
      return 'wz-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
    }
  }

  function newWizard() {
    return {
      step: 1,
      role: 'buy',
      asset: 'TON',
      amount: '',
      terms: '',
      deadlineH: 24,
      clientRequestId: genClientRequestId(),
      submitting: false,
    };
  }

  function viewCreate() {
    setTabbar(false);
    App.wz = newWizard();

    var box = UI.h('div', {});
    document.getElementById('view').innerHTML = '';
    document.getElementById('view').appendChild(box);

    function wizBack() {
      if (App.wz.step > 1) {
        App.wz.step--;
        renderStep();
      } else go('#/home');
    }
    setTopbar('Yangi escrow bitim', { back: wizBack });
    TG.showBack(wizBack);
    TG.preventClose(true);

    function feeOf(amountStr) {
      var n = parseFloat(amountStr);
      if (!isFinite(n) || n <= 0) return 0;
      return n * (UI.feeBpsEstimate / 10000);
    }

    function validate(step) {
      var w = App.wz;
      if (step === 2) {
        var amt = parseFloat(w.amount);
        if (!isFinite(amt) || amt <= 0) {
          fail("0 dan katta to'g'ri summa kiriting");
          return false;
        }
        if (amt > 1e9) {
          fail('Summa juda katta');
          return false;
        }
      }
      return true;

      function fail(msg) {
        UI.toast(msg, 'err');
        TG.haptic.error();
      }
    }

    function submit() {
      var w = App.wz;
      // Double-submit guard: the inline button AND the Telegram MainButton fire
      // the same submit — without this, 2 taps = 2 POSTs = 2 deals (ghost copy).
      if (w.submitting) return;
      w.submitting = true;
      // Freeze both triggers immediately (covers the inline+MainButton race).
      try {
        var sbtns = box.querySelectorAll('.btn-primary');
        for (var sbi = 0; sbi < sbtns.length; sbi++) sbtns[sbi].setAttribute('disabled', '');
      } catch (e) {}
      var me = App.state.meId || (TG.user && TG.user().id) || 0;
      if (!w.clientRequestId) w.clientRequestId = genClientRequestId();
      var payload = {
        sellerId: w.role === 'sell' ? me : null,
        buyerId: w.role === 'buy' ? me : null,
        role: w.role,
        asset: w.asset,
        amount: parseFloat(w.amount),
        terms: w.terms || '',
        deadline: new Date(Date.now() + w.deadlineH * 3600000).toISOString(),
        clientRequestId: w.clientRequestId,
      };
      if (!TG.available) UI.toast('Bitim yaratilmoqda…');
      else TG.main.show('Yaratilmoqda…', function () {}, { progress: true });

      Api.createDeal(payload)
        .then(function (res) {
          w.submitting = false;
          TG.haptic.success();
          TG.preventClose(false);
          TG.main.hide();
          // Prefer bot link (t.me) for Telegram approval flow; fallback to webapp
          var shareLink = res.botLink || res.link || res.webappLink || '';
          App.state.createdLinks[res.deal.id] = shareLink;
          renderSuccess(res.deal, shareLink);
        })
        .catch(function (err) {
          // Same clientRequestId is kept: a retry after timeout reuses it, so
          // the backend returns the already-created deal instead of a duplicate.
          w.submitting = false;
          TG.haptic.error();
          TG.main.hide();
          renderStep();
          UI.toast(err.status === 0 ? "Tarmoqqa ulanib bo'lmadi" : 'Xatolik: ' + err.message, 'err');
        });
    }

    function renderSuccess(deal, link) {
      setTopbar('Bitim yaratildi', {
        back: function () {
          go('#/deal/' + deal.id);
        },
      });
      TG.showBack(function () {
        go('#/deal/' + deal.id);
      });
      var shareUrl = link || location.href.split('#')[0] + '#/deal/' + deal.id;
      var isBotLink = shareUrl.indexOf('t.me/') !== -1;

      box.innerHTML = '';
      box.appendChild(
        UI.h('div', { class: 'success-panel' }, [
          UI.h('div', {
            class: 'check-ring',
            html: '<svg viewBox="0 0 34 34" width="44" height="44"><path d="M8 18l6 6L26 11"/></svg>',
          }),
          UI.h('h2', { text: 'Escrow bitim #' + deal.id + ' yaratildi' }),
          UI.h('p', {
            text: isBotLink
              ? "Bu bot havolani Telegram orqali ulashing. Sherik ochganda sizdan tasdiq so'raladi (rasmi va username ko'rinadi). Bitim siz tasdiqlagach boshlanadi."
              : "Taklif havolasini sherigingizga yuboring. Har ikki tomon rozi bo'lmaguncha mablag' xavfsiz saqlanadi.",
          }),
          UI.h('div', { class: 'link-box' }, [
            UI.h('div', { class: 'mono', text: shareUrl }),
            UI.h('button', {
              class: 'icon-btn',
              'aria-label': 'Havolani nusxalash',
              html: '<svg viewBox="0 0 24 24" width="19" height="19"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2m0 16H8V7h11z"/></svg>',
              onclick: function () {
                UI.copy(shareUrl, 'Bot taklif havolasi nusxalandi');
              },
            }),
          ]),
          UI.h('div', { class: 'btn-row' }, [
            UI.h(
              'button',
              {
                class: 'btn btn-primary',
                onclick: function () {
                  TG.share(shareUrl, "Savdochi'da escrow bitimim #" + deal.id + ' — qoshilish uchun bosing');
                },
              },
              [isBotLink ? 'Bot havolani ulashish' : 'Taklifni ulashish'],
            ),
            UI.h(
              'button',
              {
                class: 'btn btn-ghost',
                onclick: function () {
                  go('#/deal/' + deal.id);
                },
              },
              ["Bitimni ko'rish"],
            ),
          ]),
          UI.h('div', { class: 'btn-row' }, [
            UI.h(
              'button',
              {
                class: 'btn btn-soft',
                onclick: function () {
                  go('#/create');
                },
              },
              ['Yana yaratish'],
            ),
          ]),
        ]),
      );
    }

    function renderStep() {
      var w = App.wz;
      TG.main.hide();

      var dots = UI.h('div', { class: 'wizard-dots' });
      for (var i = 1; i <= 4; i++) dots.appendChild(UI.h('i', { class: i <= w.step ? 'on' : '' }));

      var body = null;

      if (w.step === 1) {
        body = [
          UI.h('h3', { style: 'font-size:18px;margin-bottom:4px', text: 'Siz qaysi tomansiz?' }),
          UI.h('p', {
            class: 'muted small',
            style: 'margin-bottom:14px',
            text: "Bu mablag'ni escrow'ga kim kiritishini belgilaydi. Yaratgandan so'ng sherikni havola orqali taklif qiling.",
          }),
          UI.h('div', { class: 'choice-row', style: 'margin-bottom:18px' }, [
            choice('buy', '🛒', 'Men olaman', "Siz kriptoni escrow'ga kiritasiz"),
            choice('sell', '💰', 'Men sotaman', 'Chiqarilgach kriptoni olasiz'),
          ]),
        ];

        function choice(key, icon, title, subtext) {
          return UI.h(
            'button',
            {
              class: 'choice-card' + (w.role === key ? ' selected' : ''),
              onclick: function () {
                TG.haptic.tap();
                w.role = key;
                Array.prototype.forEach.call(this.parentNode.children, function (c) {
                  c.classList.remove('selected');
                });
                this.classList.add('selected');
              },
            },
            [
              UI.h('span', { class: 'cc-icon', text: icon }),
              UI.h('b', { text: title }),
              UI.h('span', { text: subtext }),
            ],
          );
        }
      }

      if (w.step === 2) {
        var amountLabel = UI.h('label', { text: 'Summa (' + w.asset + ')' });
        var amountInput = UI.h('input', {
          class: 'input',
          type: 'text',
          inputmode: 'decimal',
          placeholder: '0.00',
          value: w.amount,
          oninput: function () {
            w.amount = this.value.replace(/[^0-9.,]/g, '').replace(',', '.');
            this.value = w.amount;
            updateFee();
          },
        });

        var feeLine = UI.h('div', { class: 'field-hint', style: 'margin-top:10px;font-size:13px', text: '' });

        function updateFee() {
          var f = feeOf(w.amount);
          feeLine.textContent =
            f > 0
              ? 'Escrow komissiyasi ≈ ' + UI.fmtAmount(f) + ' ' + w.asset + ' (taxm. ' + UI.feeBpsEstimate / 100 + '%)'
              : '';
        }

        body = [
          UI.h('h3', { style: 'font-size:18px;margin-bottom:14px', text: 'Aktiv va summa' }),
          UI.h('div', { class: 'choice-row', style: 'margin-bottom:18px' }, [
            assetChoice('TON', '◈', 'Toncoin', 'Native TON'),
            assetChoice('USDT', '₮', 'Tether USD', 'Jetton on TON'),
          ]),
          UI.h('div', { class: 'field' }, [
            amountLabel,
            amountInput,
            feeLine,
            UI.h(
              'div',
              { class: 'chip-row' },
              ['10', '50', '100', '500'].map(function (v) {
                return UI.h(
                  'button',
                  {
                    class: 'chip',
                    onclick: function () {
                      w.amount = v;
                      amountInput.value = v;
                      updateFee();
                      TG.haptic.tap();
                    },
                  },
                  [v],
                );
              }),
            ),
          ]),
        ];

        function assetChoice(key, glyph, title, subtext) {
          return UI.h(
            'button',
            {
              class: 'choice-card' + (w.asset === key ? ' selected' : ''),
              onclick: function () {
                TG.haptic.tap();
                w.asset = key;
                Array.prototype.forEach.call(this.parentNode.children, function (c) {
                  c.classList.remove('selected');
                });
                this.classList.add('selected');
                amountLabel.textContent = 'Summa (' + key + ')';
                updateFee();
              },
            },
            [
              UI.h('span', {
                class: 'asset-glyph ' + (key === 'TON' ? 'asset-ton' : 'asset-usdt'),
                style: 'width:38px;height:38px;font-size:17px;margin-bottom:8px',
                text: glyph,
              }),
              UI.h('b', { text: title }),
              UI.h('span', { text: subtext }),
            ],
          );
        }
      }

      if (w.step === 3) {
        var ta = UI.h('textarea', {
          class: 'input',
          maxlength: '500',
          placeholder: 'Nima savdo qilinayotgani, yetkazish shartlari, tekshirish muddati…',
          oninput: function () {
            w.terms = this.value;
            counter.textContent = this.value.length + '/500';
          },
        });
        var counter = UI.h('span', { class: 'char-count muted', text: (w.terms || '').length + '/500' });

        var dlRow = UI.h('div', { class: 'chip-row' });
        DEADLINE_OPTIONS.forEach(function (o) {
          dlRow.appendChild(
            UI.h(
              'button',
              {
                class: 'chip' + (w.deadlineH === o.h ? ' active' : ''),
                onclick: function () {
                  TG.haptic.tap();
                  w.deadlineH = o.h;
                  Array.prototype.forEach.call(dlRow.children, function (c) {
                    c.classList.remove('active');
                  });
                  this.classList.add('active');
                },
              },
              [o.label],
            ),
          );
        });

        body = [
          UI.h('h3', { style: 'font-size:18px;margin-bottom:4px', text: 'Shartlar va muddat' }),
          UI.h('p', {
            class: 'muted small',
            style: 'margin-bottom:14px',
            text: "Aniq shartlar kelishmovchilikning oldini oladi. Har ikki tomon qo'shilishdan oldin ko'radi.",
          }),
          UI.h('div', { class: 'field' }, [UI.h('label', {}, [document.createTextNode('Shartlar '), counter]), ta]),
          UI.h('div', { class: 'field' }, [
            UI.h('label', { text: 'Avto-yakunlash muddati' }),
            dlRow,
            UI.h('div', { class: 'field-hint', text: "Muddat o'tgach admin tasdiqlarga qarab bitimni yakunlaydi." }),
          ]),
        ];
      }

      if (w.step === 4) {
        var am = UI.assetMeta(w.asset);
        body = [
          UI.h('h3', { style: 'font-size:18px;margin-bottom:14px', text: 'Bitimni tekshiring' }),
          UI.h(
            'div',
            { class: 'card review-rows', style: 'padding:6px 14px' },
            [
              rrow('Sizning rolingiz', w.role === 'buy' ? "Xaridor (birinchi to'laydi)" : 'Sotuvchi (qabul qiladi)'),
              rrow('Aktiv', am.name),
              rrow('Summa', UI.fmtAmount(parseFloat(w.amount)) + ' ' + w.asset),
              rrow('Komissiya (taxm.)', UI.fmtAmount(feeOf(w.amount)) + ' ' + w.asset),
              w.terms ? rrow('Shartlar', w.terms.length > 80 ? UI.truncate(w.terms, 77, 0) : w.terms) : null,
              rrow(
                'Muddat',
                DEADLINE_OPTIONS.filter(function (o) {
                  return o.h === w.deadlineH;
                })[0].label,
              ),
            ].filter(Boolean),
          ),
          UI.h('div', { class: 'total-line' }, [
            UI.h('span', { text: 'Escrow summasi' }),
            UI.h('span', { text: UI.fmtAmount(parseFloat(w.amount)) + ' ' + w.asset }),
          ]),
          UI.h('p', {
            class: 'muted small',
            style: 'margin-top:14px',
            text: "🔒 Mablag' chiqarilgunga qadar escrow'da bloklanadi. Uni hech kim bir tomonlama sarflay olmaydi.",
          }),
        ];
      }

      box.innerHTML = '';
      box.appendChild(dots);
      body.forEach(function (el) {
        box.appendChild(el);
      });

      if (w.step < 4) {
        box.appendChild(
          UI.h(
            'div',
            { class: 'btn-row' },
            [
              w.step > 1 ? UI.h('button', { class: 'btn btn-ghost', onclick: wizBack }, ['Orqaga']) : null,
              UI.h(
                'button',
                {
                  class: 'btn btn-primary',
                  onclick: function () {
                    if (validate(w.step)) {
                      TG.haptic.light();
                      w.step++;
                      renderStep();
                    }
                  },
                },
                ['Davom etish'],
              ),
            ].filter(Boolean),
          ),
        );
      } else {
        box.appendChild(
          UI.h('div', { class: 'btn-row' }, [
            UI.h('button', { class: 'btn btn-ghost', onclick: wizBack }, ['Orqaga']),
            UI.h(
              'button',
              { class: 'btn btn-primary', onclick: submit, disabled: App.wz.submitting ? true : undefined },
              [App.wz.submitting ? 'Yaratilmoqda…' : '🔒 Bitim yaratish'],
            ),
          ]),
        );
        if (TG.available) TG.main.show('🔒 Bitim yaratish', submit);
      }
    }

    function rrow(k, v) {
      return UI.h('div', { class: 'rrow' }, [
        UI.h('span', { class: 'k', text: k }),
        UI.h('span', { class: 'v', text: v }),
      ]);
    }

    renderStep();
  }

  /* ================= Deal detail ================= */

  var CHAIN_STATUS = { 0: "To'lov kutilmoqda", 1: "Qo'yildi", 2: 'Chiqarildi', 3: 'Qaytarildi' };

  /* ================= One-tap pay (buyer, AWAITING_DEPOSIT, both joined) =================
     TON:  messages=[{address: paymentAddress, amount: totalNano(price+fee), payload: depositPayload}]
     USDT: messages=[{address: senderJettonWallet, amount: 0.05 TON gas, payload: jettonPayload}]
     (jettonPayload + paymentAddress come from GET /api/deals/:id/payload) */

  var USDT_MASTER_MAINNET = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7NwTo_DA';
  var PAY_GAS_NANO = '50000000'; // 0.05 TON — jetton transfer gas

  function feeBpsLive(deal, cb) {
    var fb = Number(deal && deal.fee_bps != null ? deal.fee_bps : UI.feeBpsEstimate || 100);
    if (!isFinite(fb) || fb < 0) fb = 100;
    fb = Math.floor(fb);
    try {
      Api.info()
        .then(function (d) {
          var b = Number(d && d.feeBps != null ? d.feeBps : fb);
          if (!isFinite(b) || b < 0) b = fb;
          cb(Math.floor(b));
        })
        .catch(function () {
          cb(fb);
        });
    } catch (e) {
      cb(fb);
    }
  }

  function calcTotals(amountHuman, feeBps, decimals) {
    var pow = Math.pow(10, decimals);
    var priceBase = Math.round(Number(amountHuman) * pow);
    if (!isFinite(priceBase) || priceBase <= 0) priceBase = 0;
    var feeBase = Math.floor((priceBase * feeBps) / 10000);
    return { price: priceBase, fee: feeBase, total: priceBase + feeBase, pow: pow };
  }

  function resolveJettonWallet(ownerAddr) {
    if (!ownerAddr) return Promise.resolve(null);
    var done = function (v) {
      return v;
    };
    try {
      var infoP =
        Api.info && typeof Api.info === 'function'
          ? Api.info().catch(function () {
              return {};
            })
          : Promise.resolve({});
      return infoP
        .then(function (info) {
          var net = String((info && info.network) || '').toLowerCase();
          if (net && net.indexOf('test') !== -1) return null;
          var url =
            'https://tonapi.io/v2/accounts/' +
            encodeURIComponent(String(ownerAddr)) +
            '/jettons/' +
            encodeURIComponent(USDT_MASTER_MAINNET);
          return fetch(url, { headers: { Accept: 'application/json' } })
            .then(function (r) {
              if (!r.ok) return null;
              return r.json();
            })
            .then(function (j) {
              var w = j && (j.wallet_address || j.jetton_wallet || j.address);
              if (w && typeof w === 'object') w = w.address || w.account || null;
              return typeof w === 'string' && w.length > 10 ? w : null;
            })
            .catch(function () {
              return null;
            });
        })
        .then(done, function () {
          return null;
        });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function oneTapPaySection(deal, payTo, am, reload) {
    var section = UI.h('div', {});
    var state = Wallet.connected() ? 'ready' : 'connect'; // connect|ready|sending|rejected|verifying|fallback
    var totals = null;
    var feeBps = Math.floor(Number(deal.fee_bps != null ? deal.fee_bps : UI.feeBpsEstimate || 100)) || 0;
    var decimals = am.symbol === 'USDT' ? 6 : 9;
    var fallbackNote = '';
    var verifyLeft = 24;

    feeBpsLive(deal, function (b) {
      feeBps = b;
      totals = calcTotals(deal.amount, feeBps, decimals);
      if (state === 'ready') render();
    });
    totals = calcTotals(deal.amount, feeBps, decimals);

    function warnBanner() {
      return UI.h('div', { class: 'banner warn', style: 'font-weight:700' }, [
        UI.h('div', { class: 'small', text: '⚠️ Birjadan yubormang, faqat hamyon ilovasidan' }),
      ]);
    }

    function render() {
      section.innerHTML = '';
      section.appendChild(UI.h('div', { class: 'section-title', text: "To'lov" }));
      var card = UI.h('div', { class: 'card', style: 'padding:6px 14px' }, [
        UI.h('div', { class: 'rrow' }, [
          UI.h('span', { class: 'k', text: "To'lov" }),
          UI.h('span', { class: 'v', text: UI.fmtAmount(totals.price / totals.pow) + ' ' + am.symbol }),
        ]),
        UI.h('div', { class: 'rrow' }, [
          UI.h('span', { class: 'k', text: 'Komissiya' }),
          UI.h('span', { class: 'v', text: UI.fmtAmount(totals.fee / totals.pow) + ' ' + am.symbol }),
        ]),
      ]);
      section.appendChild(card);
      section.appendChild(
        UI.h('div', { class: 'total-line' }, [
          UI.h('span', { text: 'Jami' }),
          UI.h('span', { text: UI.fmtAmount(totals.total / totals.pow) + ' ' + am.symbol }),
        ]),
      );
      section.appendChild(warnBanner());
      section.appendChild(
        UI.h('div', {
          class: 'field-hint',
          style: 'margin-top:8px;color:#7dd3a5',
          text: "Memo avtomatik qo'shiladi — nusxalash shart emas.",
        }),
      );

      if (state === 'connect') {
        var cbox = UI.h('div', { class: 'card', style: 'text-align:center' }, [
          UI.h('h3', { style: 'margin-bottom:6px', text: 'Avval hamyonni ulang' }),
          UI.h('p', { class: 'sub', style: 'margin-bottom:12px', text: "To'lash uchun hamyoningizni ulang." }),
          UI.h(
            'button',
            {
              class: 'btn btn-primary',
              onclick: function () {
                TG.haptic.medium();
                this.setAttribute('disabled', '');
                var btn = this;
                Wallet.connect()
                  .then(function () {
                    TG.haptic.success();
                    state = Wallet.connected() ? 'ready' : 'connect';
                    render();
                  })
                  .catch(function (err) {
                    TG.haptic.error();
                    console.warn('[Pay] connect failed', err);
                    // Fallback only when wallet can't connect
                    state = 'fallback';
                    fallbackNote = "Hamyon ulanmadi — qo'lda to'lov yo'li ochildi.";
                    render();
                  })
                  .then(function () {
                    try {
                      btn.removeAttribute('disabled');
                    } catch (e) {}
                  });
              },
            },
            ['🔌 Hamyonni ulash'],
          ),
          UI.h(
            'button',
            {
              class: 'link-btn',
              style: 'margin-top:8px',
              onclick: function () {
                state = 'fallback';
                fallbackNote = '';
                render();
              },
            },
            ["Hamyon ulanmayaptimi? Qo'lda to'lash"],
          ),
        ]);
        section.appendChild(cbox);
        if (!Wallet.available()) {
          section.appendChild(
            UI.h('div', {
              class: 'field-hint',
              style: 'text-align:center',
              text: "Hamyon SDK yuklanmoqda — tayyor bo'lmasa qo'lda to'lovdan foydalaning.",
            }),
          );
        }
      } else if (state === 'ready' || state === 'sending') {
        var busy = state === 'sending';
        var payBtn = UI.h(
          'button',
          {
            class: 'btn btn-primary pay-big',
            style: 'margin-top:12px;padding:16px;font-size:17px',
            onclick: function () {
              if (!busy) doPay();
            },
          },
          [busy ? 'Hamyon tasdiqlanmoqda…' : "To'lash"],
        );
        if (busy) payBtn.setAttribute('disabled', '');
        section.appendChild(payBtn);
      } else if (state === 'rejected') {
        section.appendChild(
          UI.h('div', { class: 'banner error' }, [
            UI.h('div', { class: 'small', text: "Bekor qilindi, qayta urinib ko'ring" }),
          ]),
        );
        section.appendChild(
          UI.h(
            'button',
            {
              class: 'btn btn-primary',
              style: 'margin-top:4px',
              onclick: function () {
                state = 'ready';
                render();
              },
            },
            ['Qayta urinish'],
          ),
        );
      } else if (state === 'verifying') {
        var vbox = UI.h('div', { class: 'card', style: 'text-align:center' }, [
          UI.h('div', {
            class: 'pay-spinner',
            html: '<svg viewBox="0 0 24 24" width="34" height="34"><path fill="currentColor" d="M12 4a8 8 0 1 0 8 8" opacity=".9"/></svg>',
          }),
          UI.h('h3', { style: 'margin:8px 0 4px', text: 'Tekshirilmoqda…' }),
          UI.h('div', { class: 'small muted pay-verify-count', text: 'Zanjir tekshirilmoqda, oynani yopmang.' }),
        ]);
        section.appendChild(vbox);
      } else if (state === 'fallback') {
        section.appendChild(fallbackBox());
      }
    }

    function fallbackBox() {
      var friendly = UI.toFriendly(payTo);
      var tonLink = 'ton://transfer/' + friendly;
      var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(tonLink);
      var wrap = UI.h('div', { class: 'card', style: 'text-align:center' });
      if (fallbackNote)
        wrap.appendChild(UI.h('div', { class: 'banner warn' }, [UI.h('div', { class: 'small', text: fallbackNote })]));
      var qr = UI.h('img', {
        src: qrUrl,
        alt: 'QR',
        style:
          'width:min(200px,62vw);height:auto;aspect-ratio:1/1;border-radius:12px;background:#fff;margin:4px auto;display:block',
      });
      qr.onerror = function () {
        try {
          qr.style.display = 'none';
        } catch (e) {}
      };
      wrap.appendChild(qr);
      wrap.appendChild(
        UI.h(
          'button',
          {
            class: 'addr-pill',
            style: 'margin-top:8px',
            onclick: function () {
              UI.copy(friendly, 'Manzil nusxalandi');
            },
          },
          [
            UI.h('span', { class: 'mono', text: UI.truncate(friendly, 10, 8) }),
            UI.h('span', { class: 'small muted', text: 'nusxalash' }),
          ],
        ),
      );
      var rcBtn = UI.h(
        'button',
        {
          class: 'btn btn-primary',
          style: 'margin-top:10px',
          onclick: function () {
            TG.haptic.medium();
            rcBtn.setAttribute('disabled', '');
            var orig = rcBtn.textContent;
            rcBtn.textContent = 'Tekshirilmoqda…';
            var rcP =
              Api.recheckDeal && typeof Api.recheckDeal === 'function'
                ? Api.recheckDeal(deal.id)
                : Promise.reject(new Error('recheck_topilmadi'));
            rcP
              .then(function () {
                return Api.deal(deal.id);
              })
              .then(function (fresh) {
                var st = String((fresh && fresh.status) || '').toUpperCase();
                if (st && st !== 'AWAITING_DEPOSIT') {
                  TG.haptic.success();
                  UI.toast("To'lov tasdiqlandi", 'ok');
                  reload();
                } else {
                  TG.haptic.error();
                  UI.toast("Hali kelib tushmadi, birozdan keyin qayta urinib ko'ring", 'err');
                  rcBtn.removeAttribute('disabled');
                  rcBtn.textContent = orig;
                }
              })
              .catch(function (err) {
                TG.haptic.error();
                UI.toast((err && err.message) || "Tekshirib bo'lmadi", 'err');
                rcBtn.removeAttribute('disabled');
                rcBtn.textContent = orig;
              });
          },
        },
        ["To'ladim, tekshiring"],
      );
      wrap.appendChild(rcBtn);
      return wrap;
    }

    function doPay() {
      state = 'sending';
      render();
      TG.haptic.medium();
      var isUsdt = am.symbol === 'USDT';
      feeBpsLive(deal, function (bps) {
        feeBps = bps;
        totals = calcTotals(deal.amount, feeBps, decimals);
        var payloadP =
          Api.dealPayload && typeof Api.dealPayload === 'function'
            ? Api.dealPayload(deal.id)
            : Promise.reject(new Error('payload_topilmadi'));
        payloadP
          .then(function (p) {
            var to = (p && p.paymentAddress) || payTo;
            if (!to) throw new Error('manzil_topilmadi');
            if (isUsdt) {
              var jettonPayload = p && p.jettonPayload;
              if (!jettonPayload) {
                var e0 = new Error('jetton_payload_topilmadi');
                e0.__fallback = true;
                throw e0;
              }
              return resolveJettonWallet(Wallet.address()).then(function (jw) {
                if (!jw) {
                  var e1 = new Error('jetton_wallet_topilmadi');
                  e1.__fallback = true;
                  throw e1;
                }
                return Wallet.sendTx([{ address: jw, amount: PAY_GAS_NANO, payload: jettonPayload }]);
              });
            }
            var payload = p && p.depositPayload;
            if (!payload) throw new Error('payload_topilmadi');
            return Wallet.sendTx([{ address: to, amount: String(totals.total), payload: payload }]);
          })
          .then(function () {
            state = 'verifying';
            verifyLeft = 24;
            render();
            startVerifyPoll();
          })
          .catch(function (err) {
            TG.haptic.error();
            if (err && err.__fallback) {
              state = 'fallback';
              fallbackNote = "Avtomatik to'lov bo'lmadi — qo'lda yuboring va tekshiring.";
              render();
              return;
            }
            console.warn('[Pay] send failed', err);
            state = 'rejected';
            render();
          });
      });
    }

    function startVerifyPoll() {
      var timer = setInterval(function () {
        verifyLeft--;
        Api.deal(deal.id)
          .then(function (fresh) {
            if (String((fresh && fresh.status) || '').toUpperCase() !== 'AWAITING_DEPOSIT') {
              clearInterval(timer);
              TG.haptic.success();
              UI.toast("To'lov tasdiqlandi", 'ok');
              reload();
            } else if (verifyLeft <= 0) {
              clearInterval(timer);
              state = 'fallback';
              fallbackNote = "Hali kelib tushmadi — qo'lda tekshiring.";
              render();
              UI.toast("Hali tasdiqlanmadi — 'To'ladim, tekshiring' ni bosing", 'err');
            } else {
              var el = section.querySelector('.pay-verify-count');
              if (el)
                el.textContent =
                  'Zanjir tekshirilmoqda (' +
                  Math.ceil(((verifyLeft * 5) / 60) * 10) / 10 +
                  ' daqiqa qoldi), oynani yopmang.';
            }
          })
          .catch(function () {
            if (verifyLeft <= 0) {
              clearInterval(timer);
              state = 'fallback';
              fallbackNote = "Tarmoq uzildi — qo'lda tekshiring.";
              render();
            }
          });
      }, 5000);
      App.cleanupFns.push(function () {
        clearInterval(timer);
      });
    }

    // Re-render when wallet connects/disconnects externally
    try {
      Wallet.onStatus(function () {
        if (state === 'connect' && Wallet.connected()) {
          state = 'ready';
          render();
        } else if (state === 'ready' && !Wallet.connected()) {
          state = 'connect';
          render();
        }
      });
    } catch (e) {}

    render();
    return section;
  }

  function payInfoSection(deal, payTo, am) {
    // Non-payer view (seller, or missing counterparty): address card only, Uzbek
    return UI.h('div', {}, [
      UI.h('div', { class: 'section-title', text: "To'lov" }),
      UI.h(
        'div',
        { class: 'card', style: 'padding:12px' },
        [
          UI.h(
            'button',
            {
              class: 'addr-pill',
              onclick: function () {
                UI.copy(UI.toFriendly(payTo), "To'lov manzili nusxalandi");
              },
            },
            [
              UI.h('span', { class: 'mono', text: UI.truncate(UI.toFriendly(payTo), 10, 8) }),
              UI.h('span', { class: 'small muted', text: 'nusxalash' }),
            ],
          ),
          UI.h('div', {
            class: 'field-hint',
            style: 'margin-top:8px;color:#7dd3a5',
            text:
              'Xaridor aniq ' + UI.fmtAmount(deal.amount) + ' ' + am.symbol + " yuboradi — memo avtomatik qo'shiladi.",
          }),
        ].filter(Boolean),
      ),
    ]);
  }

  function viewDeal(id) {
    setTabbar(true);
    setTopbar('Bitim #' + id, {
      back: function () {
        navBack('#/home');
      },
      action: {
        icon: ICON_REFRESH,
        handler: function () {
          load();
        },
      },
    });
    TG.showBack(function () {
      navBack('#/home');
    });

    var box = UI.h('div', {});
    document.getElementById('view').innerHTML = '';
    document.getElementById('view').appendChild(box);

    function load() {
      box.innerHTML = '';
      var sk = UI.h('div', {});
      sk.appendChild(UI.h('div', { class: 'sk', style: 'height:120px;border-radius:18px;margin-bottom:12px' }));
      sk.appendChild(UI.h('div', { class: 'sk', style: 'height:180px;border-radius:18px' }));
      box.appendChild(sk);

      Api.deal(id)
        .then(function (deal) {
          if (!deal) {
            box.innerHTML = '';
            box.appendChild(
              emptyState(
                '🔍',
                'Bitim topilmadi',
                "Bu bitim mavjud emas yoki o'chirilgan.",
                'Bitimlarga qaytish',
                '#/home',
              ),
            );
            return;
          }
          render(deal);
        })
        .catch(function (err) {
          box.innerHTML = '';
          if (err && err.status === 403) {
            box.appendChild(
              emptyState(
                '🔒',
                'Maxfiy bitim',
                "Bu bitim faqat xaridor va sotuvchiga ko'rinadi. Taklif qilingan bo'lsangiz, havolani token bilan oching.",
                'Bitimlarga qaytish',
                '#/home',
              ),
            );
          } else if (err && err.status === 401) {
            box.appendChild(
              emptyState(
                '🔒',
                'Avtorizatsiya kerak',
                "Maxfiy bitimni ko'rish uchun sahifani Telegram ichida oching.",
                'Bitimlarga qaytish',
                '#/home',
              ),
            );
          } else {
            box.appendChild(
              errorBox(err.message || String(err), function () {
                load();
              }),
            );
          }
        });
    }

    function render(deal) {
      var am = UI.assetMeta(deal.asset);
      var sm = UI.statusMeta(deal.status);
      var uid = App.state.meId;
      var iAmBuyer = Number(deal.buyer_telegram_id) === uid;
      var iAmSeller = Number(deal.seller_telegram_id) === uid;
      var link = App.state.createdLinks[deal.id] || '';

      var head = UI.h('div', { class: 'deal-head' }, [
        UI.h('div', { class: 'asset-glyph ' + am.cls, text: am.glyph }),
        UI.h('div', {}, [
          UI.h('span', { class: 'amt', text: UI.fmtAmount(deal.amount) }),
          UI.h('span', { class: 'cur', text: am.symbol }),
        ]),
        UI.h('div', { style: 'margin-top:8px' }, [UI.h('span', { class: 'badge ' + sm.cls, text: sm.label })]),
        UI.h('div', {
          class: 'small muted',
          style: 'margin-top:6px',
          text: UI.counterpartyLabel(deal) || 'Bitim #' + deal.id,
        }),
      ]);

      var steps = [
        { label: 'Yaratildi', time: deal.created_at },
        {
          label: "Mablag' tushdi",
          time: deal.status !== 'AWAITING_DEPOSIT' ? deal.updated_at || deal.created_at : null,
        },
        {
          label: 'Yuborildi',
          time:
            deal.status === 'ITEM_SENT' || deal.status === 'RELEASED' || deal.status === 'REFUNDED'
              ? deal.updated_at
              : null,
        },
        { label: deal.status === 'REFUNDED' ? 'Qaytarildi' : 'Chiqarildi', time: null },
      ];
      var curStep = sm.step;
      var refunded = deal.status === 'REFUNDED';
      var finalState = UI.isFinalStatus(deal.status);
      var timeline = UI.h('div', { class: 'timeline' });
      steps.forEach(function (st, idx) {
        var cls = 'tl-step ';
        if (refunded && idx === 3) cls += 'fail';
        else if (finalState && idx <= curStep) cls += 'done';
        else if (idx < curStep) cls += 'done';
        else if (idx === curStep) cls += 'now';
        else cls += 'idle';
        timeline.appendChild(
          UI.h('div', { class: cls }, [
            UI.h('div', {
              class: 'tl-dot',
              html: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
            }),
            UI.h(
              'div',
              {},
              [
                UI.h('div', { class: 'tl-label', text: st.label }),
                st.time ? UI.h('div', { class: 'tl-time', text: UI.fmtDateTime(st.time) }) : null,
              ].filter(Boolean),
            ),
          ]),
        );
      });

      function party(roleLabel, tgId, you) {
        return UI.h('div', { class: 'party' + (you ? ' you' : '') }, [
          UI.h('div', { class: 'avatar ' + UI.avatarClass(tgId), text: String(tgId == null ? '?' : tgId).slice(-2) }),
          UI.h('div', { class: 'p-role', text: roleLabel + (you ? ' · Siz' : '') }),
          UI.h('div', { class: 'p-name', text: tgId ? 'ID ' + tgId : 'Sherik kutilmoqda' }),
        ]);
      }

      var kv = UI.h(
        'div',
        { class: 'kv-list card', style: 'padding:6px 14px' },
        (function () {
          var rows = [];
          rows.push(kvRow('Yaratilgan', UI.fmtDateTime(deal.created_at)));
          if (deal.deadline) {
            var cd = UI.countdown(deal.deadline);
            rows.push(kvRow('Muddat', UI.fmtDateTime(deal.deadline) + (cd ? ' · ' + cd.text : '')));
          }
          if (deal.fee_bps != null) rows.push(kvRow('Escrow komissiyasi', Number(deal.fee_bps) / 100 + '%'));
          if (deal.fee_amount != null)
            rows.push(kvRow('Komissiya summasi', UI.fmtAmount(deal.fee_amount) + ' ' + am.symbol));
          rows.push(kvRow('Holat', sm.label));
          return rows;
        })(),
      );

      function kvRow(k, v) {
        return UI.h('div', { class: 'rrow' }, [
          UI.h('span', { class: 'k', text: k }),
          UI.h('span', { class: 'v', text: v }),
        ]);
      }

      var actions = [];
      if (link && String(deal.status).toUpperCase() === 'AWAITING_DEPOSIT') {
        actions.push(
          UI.h(
            'button',
            {
              class: 'btn btn-primary',
              onclick: function () {
                TG.share(link, "Escrow bitimimga qo'shiling #" + deal.id);
              },
            },
            ['Taklif havolasini ulashish'],
          ),
        );
      }
      actions.push(
        UI.h(
          'button',
          {
            class: 'btn btn-soft',
            onclick: function () {
              TG.haptic.light();
              go('#/deal/' + deal.id + '/chat');
            },
          },
          ['💬 Bitim chati'],
        ),
      );
      actions.push(
        UI.h(
          'button',
          {
            class: 'btn btn-ghost',
            onclick: function () {
              UI.copy(String(deal.id), 'Bitim ID nusxalandi');
            },
          },
          ['Bitim ID nusxalash'],
        ),
      );

      box.innerHTML = '';

      var addrSection = null;
      var addr = deal.contract_address || deal.payment_address;
      if (addr) {
        addrSection = UI.h('div', {}, [
          UI.h('div', { class: 'section-title', text: 'Escrow shartnomasi' }),
          UI.h('div', { class: 'card', style: 'padding:12px' }, [
            UI.h(
              'button',
              {
                class: 'addr-pill',
                onclick: function () {
                  UI.copy(addr, 'Shartnoma manzili nusxalandi');
                },
              },
              [
                UI.h('span', { class: 'mono', text: UI.truncate(addr, 10, 8) }),
                UI.h('span', { class: 'small muted', text: 'nusxalash uchun bosing' }),
              ],
            ),
            UI.h('div', { class: 'row', style: 'margin-top:10px' }, [
              UI.h(
                'a',
                {
                  class: 'link-btn',
                  href: 'https://tonviewer.com/' + addr,
                  target: '_blank',
                  rel: 'noopener',
                  onclick: function (e) {
                    e.preventDefault();
                    TG.openLink('https://tonviewer.com/' + addr);
                  },
                },
                ["Tadqiqotchida ko'rish ↗"],
              ),
              UI.h('span', { class: 'chain-chip small muted', style: 'margin-left:auto', text: '' }),
            ]),
          ]),
        ]);

        if (addr.length > 10) {
          Api.chainStatus(addr)
            .then(function (r) {
              var lbl = CHAIN_STATUS[r && r.status];
              var chip = addrSection.querySelector('.chain-chip');
              if (chip && lbl != null) chip.textContent = 'Zanjirda: ' + lbl;
            })
            .catch(function () {
              /* chain API unavailable */
            });
        }
      }

      var payTo =
        deal.payment_address && String(deal.payment_address).length > 10
          ? deal.payment_address
          : deal.contract_address && String(deal.contract_address).length > 10
            ? deal.contract_address
            : null;

      var paySection = null;
      var bothJoined = deal.buyer_telegram_id && deal.seller_telegram_id;
      if (payTo && String(deal.status).toUpperCase() === 'AWAITING_DEPOSIT' && bothJoined) {
        if (iAmBuyer)
          paySection = oneTapPaySection(deal, payTo, am, function () {
            load();
          });
        else paySection = payInfoSection(deal, payTo, am);
      } else if (payTo && String(deal.status).toUpperCase() === 'AWAITING_DEPOSIT') {
        paySection = payInfoSection(deal, payTo, am);
      }

      box.appendChild(head);
      box.appendChild(timeline);
      if (paySection) box.appendChild(paySection);
      box.appendChild(UI.h('div', { class: 'section-title', text: 'Tomonlar' }));
      box.appendChild(
        UI.h('div', { class: 'parties', style: 'margin-bottom:12px' }, [
          party('Xaridor', deal.buyer_telegram_id, iAmBuyer),
          party('Sotuvchi', deal.seller_telegram_id, iAmSeller),
        ]),
      );

      if (deal.terms) {
        box.appendChild(UI.h('div', { class: 'section-title', text: 'Shartlar' }));
        box.appendChild(
          UI.h('div', {
            class: 'card',
            style: 'user-select:text;white-space:pre-wrap;font-size:14px',
            text: deal.terms,
          }),
        );
      }

      box.appendChild(UI.h('div', { class: 'section-title', text: 'Tafsilotlar' }));
      box.appendChild(kv);
      if (addrSection) box.appendChild(addrSection);

      box.appendChild(UI.h('div', { class: 'section-title', text: 'Harakatlar' }));
      actions.forEach(function (b) {
        box.appendChild(b);
        box.appendChild(UI.h('div', { style: 'height:8px' }));
      });
    }

    load();
  }

  /* ================= Deal chat ================= */

  function viewChat(id) {
    setTabbar(false);
    setTopbar('Bitim #' + id + ' · Suhbat', {
      back: function () {
        go('#/deal/' + id);
      },
    });
    TG.showBack(function () {
      go('#/deal/' + id);
    });

    var scroller = UI.h('div', { class: 'chat-scroll' });
    var input = UI.h('textarea', {
      rows: '1',
      placeholder: 'Xabar…',
      onkeydown: function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      },
    });
    var sendBtn = UI.h('button', {
      class: 'send-btn',
      'aria-label': 'Yuborish',
      html: '<svg viewBox="0 0 24 24" width="21" height="21"><path fill="currentColor" d="M3.4 20.4 20.9 12 3.4 3.6 3.3 10l13 2-13 2z"/></svg>',
      onclick: send,
    });
    var statusBar = UI.h('div', {
      class: 'small muted',
      style: 'text-align:center;padding:6px;font-size:12px',
      text: '🔒 Shifrlangan kanal — yuklanmoqda…',
    });

    document.getElementById('view').innerHTML = '';
    document
      .getElementById('view')
      .appendChild(
        UI.h('div', { class: 'chat-wrap' }, [
          statusBar,
          scroller,
          UI.h('div', { class: 'composer' }, [input, sendBtn]),
        ]),
      );

    var dealKey = null;
    var keyReady = false;
    var keyError = null;
    var consecutiveFails = 0;

    function bubble(msg) {
      var mine = Number(msg.sender_telegram_id) === App.state.meId;
      var displayText = msg.decrypted || msg.content || '';
      if (msg.is_encrypted && !msg.decrypted && msg.ciphertext) displayText = '🔒 Shifrlangan xabar';
      return UI.h('div', { class: 'msg' + (mine ? ' mine' : '') }, [
        UI.h('div', { class: 'bubble' }, [
          UI.h('div', { text: displayText, style: 'word-break:break-word;white-space:pre-wrap' }),
          UI.h('div', {
            class: 'm-meta',
            text:
              (mine ? '' : shortName(msg.sender_telegram_id) + ' · ') +
              UI.fmtTime(msg.created_at) +
              (msg.is_encrypted ? ' · 🔒' : ''),
          }),
        ]),
      ]);
    }

    function shortName(tid) {
      var s = String(tid == null ? '?' : tid);
      return s.length > 8 ? s.slice(0, 6) + '…' : s;
    }

    async function decryptList(list) {
      if (!keyReady || !dealKey) return list;
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.is_encrypted && m.ciphertext) {
          try {
            var plain = await ChatCrypto.decrypt(m.ciphertext, dealKey);
            m.decrypted = plain;
          } catch (e) {
            m.decrypted = "🔒 Deshifrlab bo'lmadi";
          }
        } else if (!m.is_encrypted && m.content) {
          m.decrypted = m.content;
        } else if (m.ciphertext && !m.is_encrypted) {
          // Fallback: try decrypt even if flag missing
          try {
            m.decrypted = await ChatCrypto.decrypt(m.ciphertext, dealKey);
          } catch (e) {
            m.decrypted = m.ciphertext;
          }
        }
        out.push(m);
      }
      return out;
    }

    function renderMessages(list) {
      var nearBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 60;
      scroller.innerHTML = '';
      if (!list.length) {
        scroller.appendChild(
          emptyState(
            '💬',
            "Hozircha xabarlar yo'q",
            'Savdo tafsilotlarini shu yerda kelishing. Aniq yozing. Xabarlar uchdan-uchga shifrlangan.',
          ),
        );
        return;
      }
      list.forEach(function (msg) {
        scroller.appendChild(bubble(msg));
      });
      if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
    }

    function updateStatus() {
      if (keyError) {
        statusBar.textContent = '⛔ ' + keyError;
        statusBar.style.color = '#ff6b6b';
        input.setAttribute('disabled', '');
        sendBtn.setAttribute('disabled', '');
      } else if (!keyReady) {
        statusBar.textContent = "🔒 Shifrlangan kanal o'rnatilmoqda…";
        statusBar.style.color = '';
        input.setAttribute('disabled', '');
        sendBtn.setAttribute('disabled', '');
      } else {
        statusBar.textContent = "🔒 Uchdan-uchga shifrlangan · faqat siz va sherigingiz o'qiy oladi";
        statusBar.style.color = '#7dd3a5';
        input.removeAttribute('disabled');
        sendBtn.removeAttribute('disabled');
      }
    }

    async function load() {
      try {
        var raw = await Api.chat(id);
        var decrypted = await decryptList(raw);
        renderMessages(decrypted);
        consecutiveFails = 0;
      } catch (err) {
        consecutiveFails++;
        var msg = err && err.message ? String(err.message) : String(err);
        if (err && err.status === 403) {
          scroller.innerHTML = '';
          scroller.appendChild(
            UI.h('div', { class: 'banner error' }, [
              UI.h('div', {}, [
                UI.h('div', { style: 'font-weight:700', text: 'Chat yopiq' }),
                UI.h('div', {
                  class: 'small',
                  text: "Faqat xaridor va sotuvchi o'qiy oladi va yoza oladi. Avval bitimga qo'shiling.",
                }),
              ]),
              UI.h('button', {
                class: 'link-btn',
                onclick: function () {
                  go('#/deal/' + id);
                },
                text: "Bitimni ko'rish",
              }),
            ]),
          );
          statusBar.textContent = '⛔ Bu bitim tomoni emassiz';
        } else if (err && err.status === 401) {
          scroller.innerHTML = '';
          scroller.appendChild(
            UI.h('div', { class: 'banner warn' }, [
              UI.h('div', { class: 'small', text: "Shifrlangan chat uchun Mini App'ni Telegram ichida oching." }),
            ]),
          );
          statusBar.textContent = '⛔ Telegram ichida oching';
        } else {
          // Transient: keep existing messages, show toast after 2 fails
          if (consecutiveFails >= 2) UI.toast(msg || 'Chat yuklanmadi', 'err');
        }
        // Exponential backoff for polling on repeated failures
        if (consecutiveFails >= 3 && App.chatTimer) {
          clearInterval(App.chatTimer);
          var backoff = Math.min(4000 * Math.pow(1.8, consecutiveFails - 3), 30000);
          App.chatTimer = setInterval(load, backoff);
        }
      }
    }

    async function initKey() {
      try {
        if (!window.ChatCrypto || !ChatCrypto.isAvailable()) {
          // Fallback: still try but warn — backend will also encrypt at rest
          console.warn('[Chat] WebCrypto unavailable, using server-side encryption only');
        }
        var k = await Api.dealKey(id);
        if (!k) throw new Error("Chat kaliti yo'q — avval bitimga qo'shiling");
        dealKey = k;
        keyReady = true;
        keyError = null;
        updateStatus();
        await load();
      } catch (err) {
        var m = err && err.message ? err.message : String(err);
        if (err && err.status === 403) {
          keyError = "Bu bitim tomoni emassiz — avval qo'shiling";
        } else if (err && err.status === 401) {
          keyError = 'Shifrlangan chat uchun Telegram ichida oching';
        } else {
          keyError = m || "Shifrlangan kanal o'rnatilmadi";
        }
        updateStatus();
        // Still try to load to show proper banner from load()
        try {
          await load();
        } catch (e) {}
        console.warn('[Chat] key init failed', err);
      }
    }

    async function send() {
      var text = input.value.trim();
      if (!text) return;
      if (!keyReady || !dealKey) {
        UI.toast(keyError || 'Shifrlangan kanal tayyor emas', 'err');
        return;
      }
      if (!TG.realUser()) {
        UI.toast('Xavfsiz yozish uchun Telegram ichida oching', 'err');
        return;
      }
      if (text.length > 4000) {
        UI.toast('Xabar juda uzun (maks 4000)', 'err');
        return;
      }
      input.value = '';
      sendBtn.setAttribute('disabled', '');
      TG.haptic.light();
      try {
        var ciphertext = await ChatCrypto.encrypt(text, dealKey);
        await Api.sendChatEncrypted(id, App.state.meId, ciphertext);
        await load();
        scroller.scrollTop = scroller.scrollHeight;
      } catch (err) {
        var em = err && err.message ? err.message : 'Yuborilmadi';
        UI.toast(em, 'err');
        input.value = text;
        // If encryption failed due to key, try refresh key once
        if (String(em).indexOf('key') !== -1) {
          try {
            dealKey = await Api.dealKey(id);
            keyReady = !!dealKey;
            updateStatus();
          } catch (e) {}
        }
      } finally {
        sendBtn.removeAttribute('disabled');
        updateStatus();
      }
    }

    // Boot
    updateStatus();
    initKey();
    App.chatTimer = setInterval(load, 3500);
    App.cleanupFns.push(function () {
      if (App.chatTimer) clearInterval(App.chatTimer);
    });
    App.cleanupFns.push(function () {
      if (window.ChatCrypto) ChatCrypto.clearCache(id);
    });
  }

  /* ================= Bitimga qo'shilish ================= */

  function joinErrUz(msg) {
    var m = String(msg || '');
    if (m.indexOf('already_party_to_deal') !== -1) return 'Siz allaqachon bitimdasiz';
    if (m.indexOf('deal_already_full') !== -1) return "Bitim allaqachon to'lgan";
    if (m.indexOf('link_expired') !== -1) return "Havola muddati o'tgan";
    if (m.indexOf('invalid_token') !== -1) return "Havola noto'g'ri";
    if (m.indexOf('deal_has_no_buyer_creator') !== -1) return "Bitimda yaratuvchi yo'q";
    return m || "Qo'shilib bo'lmadi";
  }

  function viewJoin(id, token) {
    setTabbar(true);
    setTopbar("Bitimga qo'shilish #" + id, {
      back: function () {
        go('#/home');
      },
    });
    TG.showBack(function () {
      go('#/home');
    });

    var box = UI.h('div', {});
    document.getElementById('view').innerHTML = '';
    document.getElementById('view').appendChild(box);
    box.appendChild(UI.h('div', {}, UI.skeletonDeals(1)));

    function showPending() {
      box.innerHTML = '';
      box.appendChild(
        UI.h('div', { class: 'success-panel' }, [
          UI.h('div', {
            class: 'check-ring',
            html: '<svg viewBox="0 0 34 34" width="44" height="44"><path d="M8 18l6 6L26 11"/></svg>',
          }),
          UI.h('h2', { text: "So'rov yuborildi" }),
          UI.h('p', { text: "Yaratuvchi kiruvchi so'rovlarda tasdiqlaydi. Tasdiqlangach bitim boshlanadi." }),
          UI.h('div', { class: 'btn-row' }, [
            UI.h(
              'button',
              {
                class: 'btn btn-primary',
                onclick: function () {
                  go('#/home');
                },
              },
              ['Bosh sahifa'],
            ),
          ]),
        ]),
      );
    }

    Api.deal(id, token)
      .then(function (deal) {
        box.innerHTML = '';
        if (!deal) {
          box.appendChild(
            emptyState(
              '😕',
              'Bitim topilmadi',
              "Taklif eskirgan yoki noto'g'ri bo'lishi mumkin.",
              'Bosh sahifa',
              '#/home',
            ),
          );
          return;
        }
        var am = UI.assetMeta(deal.asset);
        var content = UI.h('div', {}, [
          UI.h('h3', { text: "Escrow bitimga qo'shilish #" + deal.id }),
          UI.h('p', {
            class: 'sub',
            text:
              'Summa ' + UI.fmtAmount(deal.amount) + ' ' + am.symbol + ' · Holat: ' + UI.statusMeta(deal.status).label,
          }),
          UI.h('div', { class: 'card review-rows', style: 'padding:6px 14px;margin-bottom:16px' }, [
            UI.h('div', { class: 'rrow' }, [
              UI.h('span', { class: 'k', text: 'Xaridor' }),
              UI.h('span', { class: 'v', text: deal.buyer_telegram_id || '—' }),
            ]),
            UI.h('div', { class: 'rrow' }, [
              UI.h('span', { class: 'k', text: 'Sotuvchi' }),
              UI.h('span', { class: 'v', text: deal.seller_telegram_id || '—' }),
            ]),
          ]),
          UI.h(
            'button',
            {
              class: 'btn btn-primary',
              onclick: doJoin,
            },
            ["Qo'shilish"],
          ),
          UI.h('div', {
            class: 'field-hint',
            style: 'text-align:center;margin-top:8px',
            text: "Yaratuvchi kiruvchi so'rovlarda tasdiqlaydi",
          }),
        ]);

        UI.sheetOpen(content, {});

        function doJoin() {
          TG.haptic.medium();
          Api.joinDeal(id, token)
            .then(function (res) {
              TG.haptic.success();
              UI.sheetClose();
              if (res && (res.pending || res.requestId)) {
                UI.toast("So'rov yuborildi — yaratuvchi kiruvchi so'rovlarda tasdiqlaydi", 'ok');
                showPending();
              } else {
                UI.toast("Bitimga qo'shildingiz", 'ok');
                go('#/deal/' + id);
              }
            })
            .catch(function (err) {
              TG.haptic.error();
              UI.toast(joinErrUz(err && err.message), 'err');
            });
        }
      })
      .catch(function (err) {
        box.innerHTML = '';
        if (err && err.status === 403) {
          box.appendChild(
            emptyState(
              '🔒',
              'Maxfiy bitim',
              "Bu bitim maxfiy — faqat xaridor, sotuvchi yoki taklif egasi ko'ra oladi.",
              'Bosh sahifa',
              '#/home',
            ),
          );
        } else if (err && err.status === 401) {
          box.appendChild(
            emptyState(
              '🔒',
              'Avtorizatsiya kerak',
              "Taklifni ko'rish uchun havolani Telegram ichida oching.",
              'Bosh sahifa',
              '#/home',
            ),
          );
        } else {
          box.appendChild(
            emptyState('📡', 'Bitim yuklanmadi', "Internetni tekshirib qayta urinib ko'ring.", 'Bosh sahifa', '#/home'),
          );
        }
      });
  }

  /* ================= Profile ================= */

  // Single dark theme — the white/light theme was removed from the project.
  // Kept as no-op aliases so existing call sites keep working; always dark.
  function applyThemeMode() {
    try {
      document.body.setAttribute('data-theme-mode', 'dark');
      localStorage.setItem('Savdochi:theme', 'dark');
    } catch (e) {
      /* ignore */
    }
  }

  function getThemeMode() {
    return 'dark';
  }

  function viewProfile() {
    setTabbar(true);
    setTopbar('Hisob', {
      back: function () {
        navBack('#/home');
      },
    });
    TG.showBack(function () {
      navBack('#/home');
    });

    var u = App.state.user || {};
    var initial = ((u.first_name || u.username || '?').trim()[0] || '?').toUpperCase();

    var isAdmin =
      App.state.admins.indexOf(App.state.meId) !== -1 || App.state.admins.map(Number).indexOf(App.state.meId) !== -1;

    var connValue = UI.h('span', {
      class: 'li-value',
      text: App.state.apiOk === null ? 'Tekshirilmoqda…' : App.state.apiOk ? 'Ulangan' : 'Oflayn',
    });
    var connDot = UI.h('span', { class: 'dot ' + (App.state.apiOk ? 'on' : 'off') });

    var root = UI.h('div', {}, [
      UI.h('div', { class: 'card profile-card' }, [
        u.photo_url
          ? UI.h('img', { class: 'avatar ' + UI.avatarClass(u.id), src: u.photo_url, alt: '' })
          : UI.h('div', { class: 'avatar ' + UI.avatarClass(u.id), text: initial }),
        UI.h('h2', { text: u.first_name ? u.first_name + (u.last_name ? ' ' + u.last_name : '') : 'Mehmon' }),
        UI.h('div', { class: 'pid', text: (u.username ? '@' + u.username + ' · ' : '') + 'ID ' + (u.id || '—') }),
      ]),
      UI.h('div', { class: 'section-title', text: 'Sozlamalar' }),
      UI.h('div', { class: 'card', style: 'padding:8px 14px 14px' }, [
        UI.h('div', { class: 'list-item', style: 'border-bottom:0;padding-bottom:4px' }, [
          UI.h('div', { class: 'li-icon', text: '🎨' }),
          UI.h('div', { class: 'li-main' }, [
            UI.h('b', { text: "Ko'rinish" }),
            UI.h('span', { text: "Qorong'u mavzu" }),
          ]),
        ]),
      ]),
      UI.h('div', { class: 'section-title', text: 'Xizmat' }),
      UI.h(
        'div',
        { class: 'card', style: 'padding:4px 14px' },
        [
          (function () {
            var walletValueEl = UI.h('span', {
              class: 'li-value',
              text: Wallet.connected()
                ? UI.shortAddr(
                    (Wallet.addressFriendly ? Wallet.addressFriendly() : UI.toFriendly(Wallet.address())) || '',
                  )
                : 'Ulash',
            });
            var walletSubEl = UI.h('span', { text: 'Tonkeeper · MyTonWallet · @wallet' });
            function updateWalletRow(acc) {
              var isConn = Wallet.connected();
              var addr = Wallet.address();
              if (acc && acc.address) {
                isConn = true;
                addr = acc.address;
              }
              if (isConn && addr) {
                var friendly = Wallet.addressFriendly ? Wallet.addressFriendly() : UI.toFriendly(addr);
                walletValueEl.textContent = UI.shortAddr(friendly);
                // Fetch balance async
                Wallet.getBalance()
                  .then(function (r) {
                    var ton = r.balanceTon || (Number(r.balance) / 1e9).toString();
                    walletSubEl.textContent =
                      Number(ton)
                        .toFixed(4)
                        .replace(/\.?0+$/, '') + ' TON';
                  })
                  .catch(function () {
                    walletSubEl.textContent = 'Ulangan';
                  });
              } else {
                walletValueEl.textContent = 'Ulash';
                walletSubEl.textContent = 'Tonkeeper · MyTonWallet · @wallet';
              }
            }
            Wallet.whenReady()
              .then(function () {
                updateWalletRow();
              })
              .catch(function () {});
            Wallet.onStatus(function (acc) {
              updateWalletRow(acc);
            });
            // Initial
            updateWalletRow();
            return UI.h(
              'button',
              {
                class: 'list-item',
                onclick: function () {
                  TG.haptic.tap();
                  if (Wallet.connected()) {
                    walletSheet();
                    return;
                  }
                  if (!Wallet.available()) {
                    UI.toast('Hamyon SDK yuklanmoqda…');
                    return;
                  }
                  Wallet.connect().catch(function (err) {
                    console.warn('[App] wallet connect failed', err);
                    UI.toast(err && err.message ? err.message : 'Hamyon ulanmadi', 'err');
                  });
                },
              },
              [
                UI.h('div', { class: 'li-icon', text: '👛' }),
                UI.h('div', { class: 'li-main' }, [UI.h('b', { text: 'Hamyon' }), walletSubEl]),
                walletValueEl,
              ],
            );
          })(),
          UI.h(
            'button',
            {
              class: 'list-item',
              onclick: function () {
                TG.haptic.tap();
                connValue.textContent = 'Tekshirilmoqda…';
                Api.info()
                  .then(function (d) {
                    App.state.admins = d.adminTelegramIds;
                    App.state.apiOk = true;
                    connDot.className = 'dot on';
                    connValue.textContent = 'Ulangan';
                    UI.toast('Server ishlayapti', 'ok');
                  })
                  .catch(function () {
                    App.state.apiOk = false;
                    connDot.className = 'dot off';
                    connValue.textContent = 'Oflayn';
                    UI.toast("Serverga ulanib bo'lmadi", 'err');
                  });
              },
            },
            [
              UI.h('div', { class: 'li-icon', text: '📡' }),
              UI.h('div', { class: 'li-main' }, [
                UI.h('b', { text: 'API ulanish' }),
                UI.h('span', { text: 'Tekshirish uchun bosing' }),
              ]),
              UI.h('span', {}, [connDot, connValue]),
            ],
          ),
          isAdmin
            ? UI.h(
                'button',
                {
                  class: 'list-item',
                  onclick: function () {
                    go('#/admin');
                  },
                },
                [
                  UI.h('div', { class: 'li-icon', text: '🛠️' }),
                  UI.h('div', { class: 'li-main' }, [
                    UI.h('b', { text: 'Admin vositalari' }),
                    UI.h('span', { text: 'Bildirishnomalar va jurnallar' }),
                  ]),
                  UI.h('span', { class: 'li-value', text: '›' }),
                ],
              )
            : null,
          UI.h(
            'button',
            {
              class: 'list-item',
              onclick: function () {
                TG.alert("Savdochi v2.0 — TON'da P2P escrow bitimlar uchun Telegram Mini App.");
              },
            },
            [
              UI.h('div', { class: 'li-icon', text: 'ℹ️' }),
              UI.h('div', { class: 'li-main' }, [
                UI.h('b', { text: 'Haqida' }),
                UI.h('span', { text: 'Versiya 2.0.0' }),
              ]),
              UI.h('span', { class: 'li-value', text: '›' }),
            ],
          ),
        ].filter(Boolean),
      ),
    ]);

    document.getElementById('view').innerHTML = '';
    document.getElementById('view').appendChild(root);
  }

  /* ================= Admin ================= */

  function viewAdmin() {
    setTabbar(false);
    setTopbar('Admin vositalari', {
      back: function () {
        go('#/profile');
      },
    });
    TG.showBack(function () {
      go('#/profile');
    });

    var sel = UI.h(
      'select',
      { class: 'input' },
      (function () {
        var opts = [UI.h('option', { value: '', text: 'Qabul qiluvchini tanlang…' })];
        App.state.admins.forEach(function (a) {
          opts.push(UI.h('option', { value: String(a), text: 'Admin · ' + a }));
        });
        opts.push(UI.h('option', { value: 'custom', text: 'Maxsus chat ID…' }));
        return opts;
      })(),
    );
    var customWrap = UI.h('div', { class: 'field hidden' }, [
      UI.h('label', { text: 'Chat ID' }),
      UI.h('input', { class: 'input', inputmode: 'numeric', placeholder: 'masalan 111111111' }),
    ]);
    var msgTa = UI.h('textarea', { class: 'input', maxlength: '500', placeholder: 'Bot orqali yuboriladigan xabar…' });
    var histBox = UI.h('div', {});

    sel.addEventListener('change', function () {
      customWrap.classList.toggle('hidden', sel.value !== 'custom');
    });

    function loadHistory() {
      histBox.innerHTML = '';
      histBox.appendChild(UI.h('div', { class: 'sk', style: 'height:64px;margin-bottom:8px' }));
      Api.notifications()
        .then(function (items) {
          histBox.innerHTML = '';
          if (!items.length) {
            histBox.appendChild(
              UI.h('p', {
                class: 'muted small',
                style: 'text-align:center;padding:14px',
                text: 'Hozircha bildirishnomalar yuborilmagan.',
              }),
            );
            return;
          }
          items.slice(0, 30).forEach(function (n) {
            histBox.appendChild(
              UI.h('div', { class: 'notif-item' }, [
                UI.h('p', { text: n.message }),
                UI.h('div', { class: 'n-meta', text: '→ chat ' + n.chat_id + ' · ' + UI.timeAgo(n.created_at) }),
              ]),
            );
          });
        })
        .catch(function () {
          histBox.innerHTML = '';
          histBox.appendChild(
            UI.h('p', {
              class: 'muted small',
              style: 'text-align:center;padding:14px',
              text: 'Bildirishnomalar yuklanmadi.',
            }),
          );
        });
    }

    var root = UI.h('div', {}, [
      UI.h('div', { class: 'banner warn' }, [
        UI.h('div', { class: 'small', text: '⚠️ Admin hudud — xabarlar bot orqali istalgan chat ID ga yetkaziladi.' }),
      ]),
      UI.h('div', { class: 'section-title', text: 'Bildirishnoma yuborish' }),
      UI.h('div', { class: 'card' }, [
        UI.h('div', { class: 'field' }, [UI.h('label', { text: 'Qabul qiluvchi' }), sel, customWrap]),
        UI.h('div', { class: 'field' }, [UI.h('label', { text: 'Xabar' }), msgTa]),
        UI.h(
          'button',
          {
            class: 'btn btn-primary',
            onclick: function () {
              var chatId = sel.value === 'custom' ? customWrap.querySelector('input').value.trim() : sel.value;
              var text = msgTa.value.trim();
              if (!chatId || !text) {
                UI.toast('Qabul qiluvchi va xabar shart', 'err');
                return;
              }
              TG.haptic.medium();
              Api.notify(chatId, text)
                .then(function () {
                  TG.haptic.success();
                  UI.toast('Bildirishnoma yuborildi', 'ok');
                  msgTa.value = '';
                  loadHistory();
                })
                .catch(function (err) {
                  TG.haptic.error();
                  UI.toast(err.status === 401 ? 'Ruxsatsiz — API ruxsat kerak' : err.message || 'Xatolik', 'err');
                });
            },
          },
          ['Bot orqali yuborish'],
        ),
      ]),
      UI.h('div', { class: 'between', style: 'margin-top:16px' }, [
        UI.h('div', { class: 'section-title', style: 'margin:0', text: "So'nggi bildirishnomalar" }),
        UI.h('button', { class: 'link-btn', onclick: loadHistory, text: 'Yangilash' }),
      ]),
      histBox,
    ]);

    document.getElementById('view').innerHTML = '';
    document.getElementById('view').appendChild(root);
    loadHistory();
  }

  /* ================= Boot ================= */

  function boot() {
    window.addEventListener('error', function (e) {
      try {
        UI.toast('Xato: ' + (e.message || "noma'lum"), 'err');
      } catch (x) {
        /* ignore */
      }
    });
    console.log('[Savdochi] build v3 — ' + new Date().toISOString());

    TG.init();
    // Prefer real Telegram user when inside Telegram; preview fallback only for browsing
    var real = TG.realUser();
    var u = real || TG.user();
    App.state.user = u;
    App.state.meId = Number(u && u.id) || 0;
    // Re-sync meId if Telegram injects user after boot (some clients delay)
    setTimeout(function () {
      var r2 = TG.realUser();
      if (r2 && Number(r2.id) !== App.state.meId) {
        App.state.user = r2;
        App.state.meId = Number(r2.id);
      }
    }, 800);
    applyThemeMode();
    bindChrome();

    var sp = TG.startParam();
    if (/^\d+\.[A-Za-z0-9_\-]+$/.test(sp)) {
      location.hash = '#/deal/' + sp.split('.')[0] + '/join/' + sp.split('.')[1];
    }

    Api.info()
      .then(function (d) {
        App.state.admins = d.adminTelegramIds || [];
        App.state.apiOk = true;
      })
      .catch(function () {
        App.state.apiOk = false;
      })
      .then(function () {
        if (!location.hash) location.hash = '#/home';
        router();
      });

    window.addEventListener('hashchange', router);
  }

  window.App = App;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
