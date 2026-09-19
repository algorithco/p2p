/* app.js — Savdochi Mini App: router, views, controllers */
(function () {
  'use strict';
  var TG = window.TG;
  var Api = window.Api;
  var UI = window.UI;
  var ChatCrypto = window.ChatCrypto;
  var Wallet = window.Wallet;
  var FX = window.FX;

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
    { re: /^#\/deal\/(\d+)\/join\/([A-Za-z0-9_-]+)$/, fn: viewJoin },
    { re: /^#\/deal\/(\d+)\/chat$/, fn: viewChat },
    { re: /^#\/deal\/(\d+)$/, fn: viewDeal },
    { re: /^#\/profile$/, fn: viewProfile },
    {
      re: /^#\/admin$/,
      fn: function () {
        location.hash = '#/home';
        if (window.UI) window.UI.toast('Admin faqat bot orqali', 'err');
      },
    },
    {
      re: /^#\/trade$/,
      fn: function () {
        location.hash = '#/rating';
      },
    },
    {
      re: /^#\/rating$/,
      fn: function () {
        return window.__viewRating && window.__viewRating();
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
    var dirBack = App._navBack;
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
    root.classList.remove('view-enter', 'view-enter-fwd', 'view-enter-back');
    void root.offsetWidth;

    if (!matched) {
      location.hash = '#/home';
      return;
    }
    matched.fn.apply(null, m.slice(1));
    // directional entrance: back navigations slide from the top, forward from below
    root.classList.add(dirBack ? 'view-enter-back' : 'view-enter-fwd');
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

  /* Pull-to-refresh — bound once, active only on Home (and any view exposing App._homeReload) */
  function bindPullToRefresh(viewEl) {
    if (!viewEl || App._ptrBound) return;
    App._ptrBound = true;
    var py0 = 0,
      pdist = 0,
      pactive = false;
    viewEl.addEventListener(
      'touchstart',
      function (e) {
        pactive = false;
        if (!App._homeReload) return;
        if (!/^#\/home/.test(location.hash || '#/home')) return;
        if (viewEl.scrollTop > 2 || e.touches.length !== 1) return;
        if (!viewEl.querySelector('.ptr')) return;
        pactive = true;
        py0 = e.touches[0].clientY;
        pdist = 0;
      },
      { passive: true },
    );
    viewEl.addEventListener(
      'touchmove',
      function (e) {
        if (!pactive) return;
        var ptrEl = viewEl.querySelector('.ptr');
        if (!ptrEl) {
          pactive = false;
          return;
        }
        pdist = Math.max(0, Math.min(96, (e.touches[0].clientY - py0) * 0.5));
        ptrEl.style.height = Math.round(pdist) + 'px';
        var sp = ptrEl.querySelector('.ptr-spinner');
        if (sp) sp.style.transform = 'rotate(' + Math.round(pdist * 3.5) + 'deg)';
        ptrEl.classList.toggle('ready', pdist > 52);
        if (pdist > 4) e.preventDefault();
      },
      { passive: false },
    );
    viewEl.addEventListener('touchend', function () {
      if (!pactive) return;
      pactive = false;
      var ptrEl = viewEl.querySelector('.ptr');
      if (pdist > 52 && App._homeReload) {
        TG.haptic.light();
        if (ptrEl) ptrEl.classList.add('busy');
        Promise.resolve(App._homeReload(true))
          .catch(function () {})
          .then(function () {
            if (ptrEl) {
              ptrEl.classList.remove('busy', 'ready');
              ptrEl.style.height = '0px';
            }
          });
      } else if (ptrEl) {
        ptrEl.style.transition = 'height .2s var(--ease)';
        ptrEl.style.height = '0px';
        ptrEl.classList.remove('ready');
        setTimeout(function () {
          ptrEl.style.transition = '';
        }, 220);
      }
      pdist = 0;
    });
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
    var sm = UI.statusMeta(deal.status, deal);
    var uid = App.state.meId;
    var iAmBuyer = Number(deal.buyer_telegram_id) === uid;
    var otherRole = iAmBuyer ? 'Sotuvchi' : 'Xaridor';
    var otherId = iAmBuyer ? deal.seller_telegram_id : deal.buyer_telegram_id;
    var sub = otherId
      ? otherRole + ' · ID ' + otherId
      : (deal.buyer_telegram_id ? 'Xaridor ' + deal.buyer_telegram_id : 'Ochiq bitim') +
        (deal.seller_telegram_id ? ' · Sotuvchi ' + deal.seller_telegram_id : '');
    var chev = UI.h('div', { class: 'deal-chevron' }, [UI.icon('chevron-down', 'ico-chev')]);

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
        UI.h('div', { class: 'deal-top' }, [
          UI.assetIcon(am),
          UI.h('div', { class: 'deal-mid' }, [
            UI.h('div', { class: 'deal-title', text: 'Bitim #' + deal.id + ' · ' + am.symbol }),
            UI.h('div', { class: 'deal-sub', text: sub }),
          ]),
          UI.h('div', { class: 'deal-amt' }, [
            UI.h('b', { text: UI.fmtAmount(deal.amount) + ' ' + am.symbol }),
            UI.h('div', {}, [
              UI.h(
                'span',
                { class: 'badge ' + sm.cls, style: 'margin-top:5px' },
                (function () {
                  var st = String(deal.status || '').toUpperCase();
                  var kids = [];
                  if (st === 'RELEASE_PENDING' || st === 'REFUND_PENDING') kids.push(UI.icon('clock', ''));
                  else if (st === 'RELEASED' || st === 'CLOSED') kids.push(UI.icon('circle-check-big', 'ico-pop'));
                  else {
                    try {
                      var c = deal.confirmations;
                      if (typeof c === 'string') c = JSON.parse(c);
                      if (c && c.disputed === true) kids.push(UI.icon('alarm-clock', 'ico-ring'));
                    } catch (e) {}
                  }
                  kids.push(UI.h('span', { text: sm.label }));
                  return kids;
                })(),
              ),
            ]),
          ]),
          chev,
        ]),
      ],
    );
  }

  function emptyState(art, title, text, ctaText, ctaHash) {
    var isShield = art === '🛡️' || art === '🔒' || art === '🔍';
    var artEl;
    if (isShield) {
      var shieldSvg =
        art === '🔒'
          ? '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" stroke-width="1.7"><rect x="7" y="10" width="10" height="8" rx="1.5"/><path d="M10 10V8.5A2.5 2.5 0 0 1 12.5 6h0A2.5 2.5 0 0 1 15 8.5V10"/><circle cx="12" cy="14" r="1.2" fill="#A78BFA" stroke="none"/></svg>'
          : art === '🔍'
            ? '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" stroke-width="1.7"><circle cx="11" cy="11" r="6"/><path d="M15 15 19 19"/></svg>'
            : '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" stroke-width="1.7"><path d="M12 3 5 7v6c0 4.2 2.9 8 7 9 4.1-1 7-4.8 7-9V7l-7-4Z"/><path d="M9 12.5 11.2 15 15 9"/></svg>';
      artEl = UI.h('div', { class: 'art', html: shieldSvg });
    } else {
      artEl = UI.h('div', { class: 'art', text: art });
    }
    var box = UI.h('div', { class: 'empty' }, [artEl, UI.h('h3', { text: title }), UI.h('p', { text: text })]);
    if (ctaText) {
      box.appendChild(
        UI.h(
          'button',
          {
            class: 'btn btn-primary',
            style: 'width:auto;padding:12px 22px',
            onclick: function () {
              TG.haptic.medium();
              go(ctaHash || '#/create');
            },
          },
          [ctaText],
        ),
      );
      // helper hint like mockup
      var hint = UI.h('div', {
        class: 'small muted',
        style: 'margin-top:10px',
        text: "Havolani ulashing — sherik bir bosingda qo'shiladi.",
      });
      box.appendChild(hint);
    }
    return box;
  }

  function errorBox(message, retry) {
    var code = String(message || '').slice(0, 120);
    var isNetwork = /network|503|unreach|timeout|failed/i.test(code);
    var human = "Serverga ulanib bo'lmadi";
    var sub = isNetwork
      ? "Internet aloqangizni tekshiring va qayta urinib ko'ring. Mablag'laringiz escrow'da xavfsiz qoladi."
      : "So'rovni bajarib bo'lmadi. Qayta urinib ko'ring.";
    return UI.h('div', { class: 'error-card' }, [
      UI.h('div', {
        class: 'error-icon',
        html: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13.5 13.5 9 9"/><path d="M16.5 9a5 5 0 0 0-7 0"/><path d="M18.8 6.7a8 8 0 0 0-11.6 0"/><path d="M8 14a3 3 0 0 1 4 0"/><path d="M9 18h6"/><path d="M12 18v2"/></svg>',
      }),
      UI.h('div', { style: 'flex:1;min-width:0' }, [
        UI.h('h4', { text: human }),
        UI.h('div', { class: 'sub', text: sub }),
        UI.h('div', { class: 'code', text: code }),
        UI.h(
          'div',
          { style: 'display:flex;gap:8px;margin-top:12px' },
          [
            retry
              ? UI.h('button', {
                  class: 'btn btn-primary',
                  style: 'flex:1;padding:11px',
                  onclick: function () {
                    TG.haptic.medium();
                    retry();
                  },
                  text: 'Retry',
                })
              : null,
            UI.h('button', {
              class: 'btn btn-ghost',
              style: 'flex:1',
              onclick: function () {
                UI.toast("Offline rejim — keyinroq sinab ko'ring");
              },
              text: 'Go offline',
            }),
          ].filter(Boolean),
        ),
      ]),
    ]);
  }

  /* ============ Join requests — inline approve/reject (deal detail + chat) ============
     Renders pending join requests with ✅/❌ right where the creator looks
     (deal page + Mini App chat). This is the ONLY approval place — no separate page, no bot buttons.
     - Empty → renders nothing (no noise).
     - Polls every pollMs; timer auto-cleared on route change via cleanupFns.
     - onChange() fires after approve/reject so the host view reloads. */
  function joinRequestsBox(dealId, opts) {
    opts = opts || {};
    var compact = !!opts.compact;
    var pollMs = opts.pollMs || 8000;
    var onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {};
    var notifyNew = opts.notifyNew !== false;
    // asMessages: render each request as an incoming message bubble (for the
    // chat flow) instead of a standalone card (deal page top). Same buttons.
    var asMessages = !!opts.asMessages;
    var box = UI.h('div', { class: 'join-req-box' });
    var prevCount = null;
    var stopped = false;
    var photoCache = {}; // requestId -> objectURL (revoked on unmount)

    function setBusy(btns, busy) {
      btns.forEach(function (b) {
        if (!b) return;
        if (busy) b.setAttribute('disabled', '');
        else b.removeAttribute('disabled');
      });
    }

    function doApprove(r, btns) {
      setBusy(btns, true);
      TG.haptic.medium();
      Api.approveJoin(dealId, r.id)
        .then(function () {
          TG.haptic.success();
          UI.toast('Tasdiqlandi — bitim boshlandi', 'ok');
          onChange();
          loadReqs();
        })
        .catch(function (err) {
          TG.haptic.error();
          var m = String((err && err.message) || '');
          if (m.indexOf('already_handled') !== -1 || m.indexOf('request_already') !== -1) {
            UI.toast("So'rov allaqachon ko'rib chiqilgan", 'err');
            onChange();
            loadReqs();
          } else if (m.indexOf('link_expired') !== -1) {
            UI.toast('Taklif havolasi eskirgan — yangi havola yarating', 'err');
            onChange();
            loadReqs();
          } else if (m.indexOf('deal_already_full') !== -1) {
            UI.toast("Bitim allaqachon to'lgan", 'err');
            onChange();
            loadReqs();
          } else if (m.indexOf('not_authorized') !== -1) {
            UI.toast('Faqat bitim yaratuvchisi tasdiqlay oladi', 'err');
          } else {
            UI.toast("Tasdiqlanmadi — qayta urinib ko'ring", 'err');
          }
          setBusy(btns, false);
        });
    }

    function doReject(r, btns) {
      setBusy(btns, true);
      TG.haptic.medium();
      Api.rejectJoin(dealId, r.id)
        .then(function () {
          TG.haptic.success();
          UI.toast("So'rov rad etildi", 'ok');
          onChange();
          loadReqs();
        })
        .catch(function (err) {
          TG.haptic.error();
          var m = String((err && err.message) || '');
          if (m.indexOf('already_handled') !== -1 || m.indexOf('request_already') !== -1) {
            UI.toast("So'rov allaqachon ko'rib chiqilgan", 'err');
            onChange();
            loadReqs();
          } else {
            UI.toast("Rad etilmadi — qayta urinib ko'ring", 'err');
          }
          setBusy(btns, false);
        });
    }

    // Avatar with secure photo: file_id rows load via the authed photo proxy
    // (object URL, revoked on unmount); legacy http(s) photo_url renders directly.
    function avatarFor(r, name) {
      var slot = UI.h('div', { style: 'width:40px;height:40px;flex-shrink:0' });
      var fallback = UI.h('div', {
        class: 'avatar ' + UI.avatarClass(r.requester_telegram_id),
        style: 'width:40px;height:40px;font-size:15px;margin:0;flex-shrink:0',
        text: String(name).slice(0, 2),
      });
      slot.appendChild(fallback);
      function setImg(src) {
        if (stopped || !src) return;
        try {
          slot.innerHTML = '';
          slot.appendChild(
            UI.h('img', {
              src: src,
              alt: '',
              style: 'width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0',
            }),
          );
        } catch (e) {}
      }
      if (r.requester_photo_file_id) {
        Api.joinRequestPhoto(dealId, r.id)
          .then(function (objUrl) {
            if (objUrl) {
              photoCache[r.id] = objUrl;
              setImg(objUrl);
            }
          })
          .catch(function () {});
      } else if (r.requester_photo_url && /^https?:\/\//i.test(String(r.requester_photo_url))) {
        var probe = new Image();
        probe.onload = function () {
          setImg(String(r.requester_photo_url));
        };
        probe.src = String(r.requester_photo_url);
      }
      return slot;
    }

    function reqCard(r) {
      var name = r.requester_first_name || r.requester_username || 'ID ' + r.requester_telegram_id;
      var uname = r.requester_username ? '@' + r.requester_username : 'ID ' + r.requester_telegram_id;
      var when = '';
      try {
        when = UI.timeAgo(r.created_at);
      } catch (e) {
        when = '';
      }
      var approveBtn, rejectBtn;
      approveBtn = UI.h(
        'button',
        {
          class: 'btn btn-primary',
          style: compact ? 'flex:1;padding:10px;font-size:13.5px' : '',
          onclick: function () {
            doApprove(r, [approveBtn, rejectBtn]);
          },
        },
        [UI.icon('circle-check-big', 'ico-pop'), ' Tasdiqlash'],
      );
      rejectBtn = UI.h(
        'button',
        {
          class: 'btn btn-ghost',
          style: compact ? 'flex:1;padding:10px;font-size:13.5px' : '',
          onclick: function () {
            doReject(r, [approveBtn, rejectBtn]);
          },
        },
        [UI.icon('trash-2', 'ico-shake'), ' Rad etish'],
      );
      if (asMessages) {
        return UI.h('div', { class: 'msg' }, [
          UI.h('div', { class: 'bubble join-bubble' }, [
            UI.h('div', { class: 'join-head' }, [
              avatarFor(r, name),
              UI.h('div', { style: 'min-width:0;flex:1' }, [
                UI.h('b', { text: name, style: 'font-size:13.5px' }),
                UI.h('div', { class: 'small muted', text: uname + (when ? ' · ' + when : '') }),
              ]),
            ]),
            UI.h('div', { style: 'font-size:13.5px;margin:2px 0 4px', text: "Bitimga qo'shilmoqchi 🤝" }),
            UI.h('div', { class: 'join-msg-actions' }, [approveBtn, rejectBtn]),
          ]),
        ]);
      }
      var card = UI.h('div', { class: 'studio-card inbox-card', style: compact ? 'margin-bottom:8px' : '' }, [
        UI.h('div', { class: 'studio-head' }, [
          avatarFor(r, name),
          UI.h('div', { style: 'min-width:0' }, [
            UI.h('b', { text: name }),
            UI.h('div', { class: 'small muted', text: uname + (when ? ' · ' + when : '') }),
          ]),
        ]),
        UI.h('div', { class: 'inbox-actions', style: compact ? 'margin-top:8px' : '' }, [approveBtn, rejectBtn]),
      ]);
      return card;
    }

    function render(list) {
      revokePhotos();
      box.innerHTML = '';
      if (!list || !list.length) {
        prevCount = 0;
        return;
      }
      if (notifyNew && prevCount !== null && list.length > prevCount) {
        try {
          TG.haptic.success();
        } catch (e) {}
        UI.toast("Yangi qo'shilish so'rovi keldi", 'ok');
      }
      prevCount = list.length;
      // Card mode keeps its section header; message mode is self-explanatory
      // (each bubble carries who + ✅/❌), so no header inside the chat flow.
      if (!asMessages) {
        box.appendChild(
          UI.h('div', {
            class: 'small muted',
            style: 'margin:0 2px 8px;font-weight:700',
            text: "Kutilayotgan so'rovlar (" + list.length + ') — shu yerda tasdiqlang',
          }),
        );
      }
      list.forEach(function (r) {
        box.appendChild(reqCard(r));
      });
    }

    function loadReqs() {
      if (stopped) return;
      Api.joinRequests(dealId)
        .then(function (rows) {
          if (!stopped) render(rows || []);
        })
        .catch(function () {
          /* 403/401 → not a party: stay silent, host view shows its own banner */
        });
    }

    function revokePhotos() {
      Object.keys(photoCache).forEach(function (k) {
        try {
          URL.revokeObjectURL(photoCache[k]);
        } catch (e) {}
        delete photoCache[k];
      });
    }

    loadReqs();
    var timer = setInterval(loadReqs, pollMs);
    App.cleanupFns.push(function () {
      stopped = true;
      if (timer) clearInterval(timer);
      revokePhotos();
    });
    return box;
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
          if (Wallet.connected()) {
            walletSheet();
            return;
          }
          // Native TON Connect modal (wallet chooser) — no custom picker sheet.
          Wallet.connect().catch(function (err) {
            console.warn('[App] wallet connect failed', err);
            UI.toast('Hamyon ulanmadi', 'err');
          });
        },
      },
      [UI.icon('unplug', ''), ' Hamyonni ulash'],
    );
    var wrap = UI.h(
      'div',
      { class: 'wallet-pill-wrap', style: 'display:flex;align-items:center;flex-wrap:wrap;gap:8px' },
      [btn, balEl],
    );

    // Rebuild the disconnected pill (btn.textContent would drop the SVG icon).
    var showConnect = function () {
      btn.classList.remove('connected');
      btn.classList.remove('dot');
      while (btn.firstChild) btn.removeChild(btn.firstChild);
      btn.appendChild(UI.icon('unplug', ''));
      btn.appendChild(document.createTextNode(' Hamyonni ulash'));
      balEl.textContent = '';
      balEl.style.display = 'none';
    };

    var render = function (acc) {
      var isConn = Wallet.connected();
      var addr = Wallet.address();
      if (acc && acc.address) {
        isConn = true;
        addr = acc.address;
      }
      if (isConn && addr) {
        var friendly = Wallet.addressFriendly ? Wallet.addressFriendly() : UI.toFriendly ? UI.toFriendly(addr) : addr;
        var chain = Wallet.chain ? Wallet.chain() : null;
        var chainLabel =
          chain === -239 ? 'Mainnet' : chain === -3 ? 'Testnet' : chain != null ? 'Chain ' + chain : 'TON';
        btn.classList.add('connected');
        btn.classList.add('dot');
        btn.textContent = UI.shortAddr(friendly);
        balEl.textContent = chainLabel;
        balEl.style.display = '';
        // Fetch balance async — merge into pill like mockup: "UQAb…7f2k · 42.18 TON"
        balEl.textContent = '…';
        Wallet.getBalance()
          .then(function (r) {
            var ton = r.balanceTon || (Number(r.balance) / 1e9).toString();
            var n = Number(ton);
            var bal = isFinite(n) ? n.toFixed(4).replace(/\.?0+$/, '') + ' TON' : ton + ' TON';
            btn.textContent = UI.shortAddr(friendly) + ' · ' + bal;
            balEl.textContent = chainLabel;
          })
          .catch(function (err) {
            console.warn('[App] balance fetch failed', err);
            btn.textContent = UI.shortAddr(friendly);
            balEl.textContent = chainLabel;
          });
      } else {
        showConnect();
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

    var connectedBadge = UI.h(
      'div',
      {
        style:
          'display:flex;align-items:center;gap:8px;padding:10px;border-radius:12px;background:var(--success-soft);border:1px solid rgba(52,211,153,.22);margin-bottom:12px',
      },
      [
        UI.h('span', {
          style:
            'width:8px;height:8px;border-radius:50%;background:var(--success);box-shadow:0 0 0 6px var(--success-soft);display:inline-block',
        }),
        UI.h('span', { style: 'font-size:12.5px;font-weight:700', text: UI.shortAddr(friendly) + ' · connected' }),
        UI.h('span', {
          style:
            'margin-left:auto;font-size:11px;font-weight:800;padding:4px 8px;border-radius:999px;background:#0B0E14;color:var(--success);border:1px solid rgba(52,211,153,.3)',
          text: chainLabel || 'TON',
        }),
      ],
    );

    var content = UI.h('div', {}, [
      connectedBadge,
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
          UI.icon('copy', 'ico-tap'),
          UI.h('span', { class: 'small muted', text: 'nusxa' }),
        ],
      ),
      UI.h('div', { class: 'addr-pill', style: 'margin-bottom:8px;opacity:.7' }, [
        UI.h('span', { class: 'mono small', text: UI.truncate(raw, 12, 8) }),
        UI.h('span', { class: 'small muted', text: 'xom' }),
      ]),
      balRow,
      UI.h('div', { style: 'display:flex;gap:8px;margin-top:12px' }, [
        UI.h(
          'button',
          {
            class: 'btn btn-ghost',
            style: 'flex:1',
            onclick: function () {
              UI.sheetClose();
            },
          },
          [UI.icon('cross', ''), ' Yopish'],
        ),
        UI.h(
          'button',
          {
            class: 'btn btn-danger',
            style: 'flex:1',
            onclick: function () {
              TG.haptic.medium();
              Wallet.disconnect().then(function () {
                UI.sheetClose();
                UI.toast('Hamyon uzildi');
              });
            },
          },
          [UI.icon('unplug', 'ico-shake'), 'Uzish'],
        ),
      ]),
    ]);
    UI.sheetOpen(content);
  }

  /* ================= Home ================= */

  function viewHome() {
    setTabbar(true);
    setTopbar('Savdochi');

    // Home has no header: hide the global topbar while this view is mounted.
    // router() runs cleanup() before every view change, which restores it,
    // so other views are unaffected.
    var topbarEl = document.getElementById('topbar');
    var prevTopbarDisplay = topbarEl ? topbarEl.style.display : '';
    if (topbarEl) topbarEl.style.display = 'none';
    App.cleanupFns.push(function () {
      try {
        if (topbarEl) topbarEl.style.display = prevTopbarDisplay;
      } catch (e) {}
    });

    var s = App.state;
    var name = (s.user && (s.user.first_name || s.user.username)) || 'there';

    var seg = UI.h('div', { class: 'segmented' }, [
      segBtn('active', 'Faol'),
      segBtn('done', 'Yakunlangan'),
      segBtn('all', 'Barchasi'),
    ]);

    // sliding thumb indicator
    var segThumb = UI.h('div', { class: 'seg-thumb' });
    seg.appendChild(segThumb);
    function moveThumb() {
      var idx = ['active', 'done', 'all'].indexOf(App.state.filter);
      var b = seg.children[idx];
      if (!b || !b.offsetWidth) return;
      segThumb.style.width = b.offsetWidth + 'px';
      segThumb.style.transform = 'translateX(' + b.offsetLeft + 'px)';
    }
    try {
      var onResize = function () {
        moveThumb();
      };
      window.addEventListener('resize', onResize);
      App.cleanupFns.push(function () {
        window.removeEventListener('resize', onResize);
      });
    } catch (e) {}

    var stats = UI.h('div', { class: 'stats-grid' });
    var listBox = UI.h('div', { class: 'deal-list' });
    var ptr = UI.h('div', { class: 'ptr', 'aria-hidden': 'true' }, [UI.h('div', { class: 'ptr-spinner' })]);
    var heroEl = UI.h('div', { class: 'hero' }, [
      UI.h('h1', { text: 'Salom, ' + name + ' 👋' }),
      UI.h('p', { text: "Mablag'ni escrow'da bloklang va ishonchli P2P savdo qiling. Har bir bitim himoyalangan." }),
      UI.h('div', { class: 'wallet-row' }, [walletPill()]),
    ]);

    // Search bar -- mockup spec: pill, left icon, muted placeholder 50% opacity, 46px height
    var searchInputEl = UI.h('input', {
      class: 'search-input',
      placeholder: "ID, aktiv yoki sherik bo'yicha qidirish…",
      oninput: function (e) {
        App.state.searchQuery = (e.target.value || '').toLowerCase().trim();
        renderList();
      },
    });
    var searchRow = UI.h('label', { class: 'search-row', style: 'margin-top:4px;position:relative' }, [
      (function () {
        var g = UI.icon('search', '');
        g.style.cssText +=
          ';position:absolute;left:12px;top:50%;transform:translateY(-50%);opacity:.55;pointer-events:none';
        return g;
      })(),
      searchInputEl,
    ]);
    searchInputEl.style.paddingLeft = '38px';

    var root = UI.h(
      'div',
      { class: 'home' },
      [
        ptr,
        !TG.realUser()
          ? UI.h('div', { class: 'banner info' }, [
              UI.h('div', { style: 'display:flex;align-items:center;gap:8px' }, [
                UI.icon('bot-off', ''),
                UI.h('div', {
                  class: 'small',
                  text: "Ko'rib chiqish rejimi — to'liq ishlashi uchun sahifani Telegram ichida oching.",
                }),
              ]),
            ])
          : null,
        heroEl,
        stats,
        seg,
        searchRow,
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
            moveThumb();
          },
        },
        [label],
      );
    }

    function computeStats(deals) {
      var active = 0,
        done = 0;
      deals.forEach(function (d) {
        var u = String(d.status || '').toUpperCase();
        if (u === 'RELEASED' || u === 'REFUNDED' || u === 'CLOSED') done++;
        else active++;
      });
      stats.innerHTML = '';
      var keys = [done + active, active, done];
      var changed = !App._lastStats || App._lastStats.join(',') !== keys.join(',');
      App._lastStats = keys;
      [
        [done + active, 'Jami'],
        [active, 'Jarayonda'],
        [done, 'Yakunlangan'],
      ].forEach(function (p) {
        var b = UI.h('b');
        stats.appendChild(UI.h('div', { class: 'stat' }, [b, UI.h('span', { text: p[1] })]));
        if (changed && FX) FX.countUp(b, p[0]);
        else b.textContent = String(p[0]);
      });
    }

    function matchesFilter(d) {
      var u = String(d.status || '').toUpperCase();
      var f = App.state.filter;
      var q = (App.state.searchQuery || '').toLowerCase();
      if (f === 'all') {
        if (
          q &&
          String(d.id).indexOf(q) === -1 &&
          String(d.asset || '')
            .toLowerCase()
            .indexOf(q) === -1 &&
          String(d.status || '')
            .toLowerCase()
            .indexOf(q) === -1
        )
          return false;
        return true;
      }
      if (f === 'done') {
        var isDone = u === 'RELEASED' || u === 'REFUNDED' || u === 'CLOSED';
        if (!isDone) return false;
      } else {
        if (u === 'RELEASED' || u === 'REFUNDED' || u === 'CLOSED') return false;
      }
      if (q) {
        var hay = (
          String(d.id) +
          ' ' +
          String(d.asset || '') +
          ' ' +
          String(d.status || '') +
          ' ' +
          String(d.buyer_telegram_id || '') +
          ' ' +
          String(d.seller_telegram_id || '')
        ).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    }

    function renderList() {
      listBox.innerHTML = '';
      var visible = App.state.deals.filter(matchesFilter);
      if (!visible.length) {
        // Check if search active vs truly empty
        if (App.state.searchQuery) {
          var nb = UI.h('div', { class: 'empty', style: 'padding:24px 16px' }, [
            UI.h('div', {
              class: 'art',
              html: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8494AD" stroke-width="1.7"><circle cx="11" cy="11" r="6"/><path d="M15 15 19 19"/></svg>',
            }),
            UI.h('h3', { text: 'Hech narsa topilmadi' }),
            UI.h('p', { text: '"' + App.state.searchQuery + "\" bo'yicha bitim yo'q — boshqa so'z bilan qidiring." }),
            UI.h(
              'button',
              {
                class: 'btn btn-ghost',
                style: 'width:auto;padding:10px 18px',
                onclick: function () {
                  searchInputEl.value = '';
                  App.state.searchQuery = '';
                  renderList();
                },
              },
              [UI.icon('brush-cleaning', 'ico-shake'), ' Qidiruvni tozalash'],
            ),
          ]);
          listBox.appendChild(nb);
          return;
        }
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
      // entrance stagger only on the first paint of this view session
      if (firstListRender && FX) {
        FX.staggerIn(listBox.querySelectorAll('.deal-card'));
        firstListRender = false;
      }
    }
    var firstListRender = true;

    function load(silent) {
      if (!silent) {
        listBox.innerHTML = '';
        listBox.appendChild(UI.skeletonDeals(4));
        // premium skeleton for stats (3 pills)
        stats.innerHTML = '';
        for (var si = 0; si < 3; si++) {
          var skStat = UI.h('div', { class: 'stat', style: 'padding:12px 10px' }, [
            UI.h('div', { class: 'sk-line', style: 'width:38px;height:16px;margin:0 auto 8px' }),
            UI.h('span', { text: '...' }),
          ]);
          stats.appendChild(skStat);
        }
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
    App._homeReload = load;
    bindPullToRefresh(document.getElementById('view'));
    requestAnimationFrame(moveThumb);
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

  // No fixed closing time is set at creation: the backend keeps the 10h
  // unpaid auto-close (created_at based) and closes successful deals
  // (RELEASED → CLOSED) 5 min after the seller payout. The wizard sends no
  // per-deal deadline.

  function newWizard() {
    return { step: 1, role: 'buy', asset: 'TON', amount: '', terms: '' };
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
      var me = App.state.meId || (TG.user && TG.user().id) || 0;
      var payload = {
        sellerId: w.role === 'sell' ? me : null,
        buyerId: w.role === 'buy' ? me : null,
        role: w.role,
        asset: w.asset,
        amount: parseFloat(w.amount),
        terms: w.terms || '',
      };
      if (!TG.available) UI.toast('Bitim yaratilmoqda…');
      else TG.main.show('Yaratilmoqda…', function () {}, { progress: true });

      Api.createDeal(payload)
        .then(function (res) {
          TG.haptic.success();
          TG.preventClose(false);
          TG.main.hide();
          // Prefer bot link (t.me) for Telegram approval flow; fallback to webapp
          var shareLink = res.botLink || res.link || res.webappLink || '';
          App.state.createdLinks[res.deal.id] = shareLink;
          renderSuccess(res.deal, shareLink);
        })
        .catch(function (err) {
          TG.haptic.error();
          TG.main.hide();
          renderStep();
          UI.toast(err.status === 0 ? "Tarmoqqa ulanib bo'lmadi" : "Yaratilmadi — qayta urinib ko'ring", 'err');
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
            UI.h(
              'button',
              {
                class: 'icon-btn',
                'aria-label': 'Havolani nusxalash',
                onclick: function () {
                  UI.copy(shareUrl, 'Bot taklif havolasi nusxalandi');
                },
              },
              [UI.icon('copy', 'ico-tap')],
            ),
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
      if (FX) FX.confetti();
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
              UI.assetIcon(
                { symbol: key, glyph: glyph, cls: key === 'TON' ? 'asset-ton' : 'asset-usdt' },
                { style: 'width:38px;height:38px;font-size:17px;margin-bottom:8px' },
              ),
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

        body = [
          UI.h('h3', { style: 'font-size:18px;margin-bottom:4px', text: 'Shartlar' }),
          UI.h('p', {
            class: 'muted small',
            style: 'margin-bottom:14px',
            text: "Aniq shartlar kelishmovchilikning oldini oladi. Har ikki tomon qo'shilishdan oldin ko'radi.",
          }),
          UI.h('div', { class: 'field' }, [UI.h('label', {}, [document.createTextNode('Shartlar '), counter]), ta]),
          UI.h('div', { class: 'card', style: 'padding:12px 14px' }, [
            UI.h('div', { class: 'rrow' }, [
              UI.h('span', { class: 'k', text: 'Bitim muddati' }),
              UI.h('span', { class: 'v', text: '10 soat' }),
            ]),
            UI.h('div', {
              class: 'field-hint',
              style: 'margin-top:6px',
              text: "10 soat ichida to'lov bo'lmasa bitim avtomatik yopiladi (ma'lumotlar serverda saqlanadi).",
            }),
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
              rrow('Muddat', '10 soat (avtomatik)'),
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
            UI.h('button', { class: 'btn btn-primary', onclick: submit }, ['🔒 Bitim yaratish']),
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
                  .then(() => {
                    try {
                      this.removeAttribute('disabled');
                    } catch {}
                  });
              },
            },
            [UI.icon('unplug', ''), ' Hamyonni ulash'],
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
            UI.icon('copy', 'ico-tap'),
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
              .catch(function () {
                TG.haptic.error();
                UI.toast("Tekshirib bo'lmadi — qayta urinib ko'ring", 'err');
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
              UI.toast("Avtomatik to'lov bo'lmadi — qo'lda to'lang", 'err');
              return;
            }
            console.warn('[Pay] send failed', err);
            state = 'rejected';
            render();
            UI.toast("Bekor qilindi, qayta urinib ko'ring", 'err');
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
              UI.icon('copy', 'ico-tap'),
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
    // Back from a deal always goes to the main page (not history — history
    // would bounce chat <-> deal forever when coming from the chat).
    setTopbar('Bitim #' + id, {
      back: function () {
        go('#/home');
      },
      action: {
        icon: ICON_REFRESH,
        handler: function () {
          load();
        },
      },
    });
    TG.showBack(function () {
      go('#/home');
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
      var sm = UI.statusMeta(deal.status, deal);
      // Fresh uid: Telegram can inject the real user after boot, leaving App.state.meId stale.
      var uid = (function () {
        try {
          var ru = (TG.realUser && TG.realUser()) || null;
          if (ru && Number(ru.id)) return Number(ru.id);
        } catch (e) {}
        return Number(App.state.meId) || 0;
      })();
      var iAmBuyer = Number(deal.buyer_telegram_id) === uid;
      var iAmSeller = Number(deal.seller_telegram_id) === uid;
      var link = App.state.createdLinks[deal.id] || '';
      // Shared invite flow (used by the header fab + the actions button):
      // always resolve a live link via the backend — it reuses the current
      // 15-minute link and mints a new one only after expiry.
      function shareFreshInvite(btn) {
        if (btn && btn.disabled) return;
        if (btn) btn.disabled = true;
        TG.haptic.tap();
        Api.inviteLink(deal.id)
          .then(function (r) {
            var url = (r && (r.botLink || r.link || r.webappLink)) || '';
            if (!url) throw new Error('no_link');
            App.state.createdLinks[deal.id] = url;
            TG.share(url, "Escrow bitimimga qo'shiling #" + deal.id);
          })
          .catch(function () {
            UI.toast("Havola yaratilmadi — qayta urinib ko'ring", 'err');
            TG.haptic.error();
          })
          .then(function () {
            if (btn) btn.disabled = false;
          });
      }

      var head = UI.h('div', { class: 'deal-head' }, [
        UI.assetIcon(am),
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
            deal.status === 'ITEM_SENT' ||
            deal.status === 'RELEASED' ||
            deal.status === 'REFUNDED' ||
            deal.status === 'CLOSED'
              ? deal.updated_at
              : null,
        },
        { label: deal.status === 'REFUNDED' ? 'Qaytarildi' : 'Chiqarildi', time: null },
      ];
      var curStep = sm.step;
      var refunded = deal.status === 'REFUNDED';
      var finalState = UI.isFinalStatus(deal.status);
      // Circular share button (top-right of the header): mints a FRESH one-time
      // invite link via the backend — creation-time links are single-use and may
      // already be consumed or expired. Shown only while a partner is awaited.
      var needPartner = !deal.buyer_telegram_id || !deal.seller_telegram_id;
      if (needPartner && !finalState) {
        head.appendChild(
          UI.h('button', {
            class: 'deal-share-fab',
            'aria-label': 'Taklif havolasini ulashish',
            html: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.6l6.8-4M8.6 13.4l6.8 4"/></svg>',
            onclick: function (e) {
              shareFreshInvite(e && e.currentTarget);
            },
          }),
        );
      }
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

      // Avatar with real Telegram profile photo: initials render instantly,
      // then upgrade to the photo when GET /api/users/:id/photo resolves.
      // Unknown partner (tgId null) keeps the "?" placeholder; photo misses
      // keep initials — a missing photo must never blank the card.
      function partyAvatar(tgId) {
        var box = UI.h('div', {
          class: 'avatar ' + UI.avatarClass(tgId),
          text: String(tgId == null ? '?' : tgId).slice(-2),
        });
        if (tgId == null) return box;
        try {
          var p = Api.userPhoto ? Api.userPhoto(tgId) : null;
          if (p && p.then) {
            p.then(function (url) {
              if (!url) return;
              try {
                var img = document.createElement('img');
                img.className = 'avatar-img';
                img.alt = '';
                img.referrerPolicy = 'no-referrer';
                img.onerror = function () {
                  try {
                    img.remove();
                  } catch (e) {}
                };
                img.src = url;
                box.textContent = '';
                box.appendChild(img);
              } catch (e) {}
            }).catch(function () {});
          }
        } catch (e) {}
        return box;
      }
      function party(roleLabel, tgId, you) {
        return UI.h('div', { class: 'party' + (you ? ' you' : '') }, [
          partyAvatar(tgId),
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
              onclick: function (e) {
                shareFreshInvite(e && e.currentTarget);
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
          [UI.icon('message-circle', 'ico-wiggle'), ' Bitim chati'],
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
          [UI.icon('copy', 'ico-tap'), ' Bitim ID nusxalash'],
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
                UI.icon('copy', 'ico-tap'),
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
                ["Tadqiqotchida ko'rish ", UI.icon('external-link', 'ico-ext')],
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

      // Inline join requests — creator (either side) approves right here in the mini app
      (function () {
        var openSlot = !deal.buyer_telegram_id || !deal.seller_telegram_id;
        if (!openSlot || UI.isFinalStatus(deal.status)) return;
        if (!iAmBuyer && !iAmSeller) return; // only the creator (joined party) can approve
        var wrap = UI.h('div', {});
        wrap.appendChild(UI.h('div', { class: 'section-title', text: "Qo'shilish so'rovlari" }));
        wrap.appendChild(
          joinRequestsBox(deal.id, {
            pollMs: 8000,
            onChange: function () {
              load();
            },
          }),
        );
        box.appendChild(wrap);
      })();

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
    var sendBtn = UI.h(
      'button',
      {
        class: 'send-btn',
        'aria-label': 'Yuborish',
        onclick: send,
      },
      [UI.icon('send', 'ico-fly')],
    );
    // Error-only banner: the permanent "encrypted" top notice was removed —
    // error states (no key / not a party) still surface here + via toast.
    var statusBar = UI.h('div', {
      class: 'small muted',
      style: 'display:none;text-align:center;padding:6px;font-size:12px',
    });

    // Join requests live INSIDE the message flow (joinMsgBox node appended
    // after messages on every poll), not in a separate top bar.
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
      var isSys = Number(msg.sender_telegram_id) === 0;
      if (isSys) {
        var sysText = msg.decrypted || msg.content || '';
        if (msg.is_encrypted && !msg.decrypted && msg.ciphertext) sysText = '🔒 Shifrlangan xabar';
        if (!sysText) sysText = 'Tizim xabari';
        return UI.h('div', { class: 'msg sys', style: 'justify-content:center' }, [
          UI.h(
            'div',
            {
              class: 'bubble sys-bubble',
              style: 'background:var(--accent-soft);border:1px solid var(--border);text-align:center;max-width:92%',
            },
            [
              UI.h('div', { text: sysText, style: 'word-break:break-word;white-space:pre-wrap;font-size:13px' }),
              UI.h('div', {
                class: 'm-meta',
                style: 'text-align:center',
                text: 'Tizim · ' + UI.fmtTime(msg.created_at),
              }),
            ],
          ),
        ]);
      }
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

    var lastMsgCount = 0;
    function renderMessages(list) {
      var nearBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 60;
      var prevCount = lastMsgCount;
      scroller.innerHTML = '';
      if (!list.length) {
        lastMsgCount = 0;
        scroller.appendChild(
          emptyState(
            '💬',
            "Hozircha xabarlar yo'q",
            'Savdo tafsilotlarini shu yerda kelishing. Aniq yozing. Xabarlar uchdan-uchga shifrlangan.',
          ),
        );
        return;
      }
      list.forEach(function (msg, i) {
        var b = bubble(msg);
        // pop-in animation only for messages that arrived after the first paint
        if (prevCount > 0 && i >= prevCount) b.classList.add('msg-new');
        scroller.appendChild(b);
      });
      lastMsgCount = list.length;
      if (nearBottom || list.length > prevCount) scroller.scrollTop = scroller.scrollHeight;
    }

    var keyErrorToasted = false;
    function updateStatus() {
      var locked = !!keyError || !keyReady;
      if (keyError) {
        // Error-only banner (the permanent top notice is gone by design).
        statusBar.innerHTML = '';
        statusBar.style.display = '';
        statusBar.appendChild(UI.icon('cross', ''));
        statusBar.appendChild(document.createTextNode(' ' + keyError));
        statusBar.style.color = '#ff6b6b';
        if (!keyErrorToasted) {
          keyErrorToasted = true;
          try {
            UI.toast(keyError, 'err');
          } catch (e) {}
        }
      } else {
        statusBar.style.display = 'none';
      }
      if (locked) {
        input.setAttribute('disabled', '');
        sendBtn.setAttribute('disabled', '');
      } else {
        input.removeAttribute('disabled');
        sendBtn.removeAttribute('disabled');
      }
    }

    var loadErrorToasted = false;
    async function load() {
      try {
        var raw = await Api.chat(id);
        var decrypted = await decryptList(raw);
        renderMessages(decrypted);
        loadErrorToasted = false;
        // Join requests ride the message flow: re-append the live box AFTER
        // messages (renderMessages wipes the scroller). Empty box = invisible.
        if (joinMsgBox) {
          try {
            var nearBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 140;
            scroller.appendChild(joinMsgBox);
            if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
          } catch (e) {}
        }
        consecutiveFails = 0;
      } catch (err) {
        consecutiveFails++;
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
          if (!loadErrorToasted) {
            loadErrorToasted = true;
            try {
              UI.toast('Bu bitim tomoni emassiz', 'err');
            } catch (e) {}
          }
        } else if (err && err.status === 401) {
          scroller.innerHTML = '';
          scroller.appendChild(
            UI.h('div', { class: 'banner warn' }, [
              UI.h('div', { class: 'small', text: "Shifrlangan chat uchun Mini App'ni Telegram ichida oching." }),
            ]),
          );
          if (!loadErrorToasted) {
            loadErrorToasted = true;
            try {
              UI.toast('Telegram ichida oching', 'err');
            } catch (e) {}
          }
        } else {
          // Transient: keep existing messages, show toast after 2 fails
          if (consecutiveFails >= 2) UI.toast("Chat yuklanmadi — qayta urinib ko'ring", 'err');
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
        if (err && err.status === 403) {
          keyError = "Bu bitim tomoni emassiz — avval qo'shiling";
        } else if (err && err.status === 401) {
          keyError = 'Shifrlangan chat uchun Telegram ichida oching';
        } else {
          keyError = "Shifrlangan kanal o'rnatilmadi — qayta urinib ko'ring";
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
        UI.toast("Yuborilmadi — qayta urinib ko'ring", 'err');
        input.value = text;
        // If encryption failed due to key, try refresh key once
        try {
          var em2 = String((err && err.message) || '');
          if (em2.indexOf('key') !== -1 || em2.indexOf('kalit') !== -1) {
            try {
              dealKey = await Api.dealKey(id);
              keyReady = !!dealKey;
              updateStatus();
            } catch (e) {}
          }
        } catch (e2) {}
      } finally {
        sendBtn.removeAttribute('disabled');
        updateStatus();
      }
    }

    // Boot
    updateStatus();
    initKey();
    // Join approvals live INSIDE the message flow as message bubbles with
    // ✅/❌ buttons (not a separate top bar). This is the ONLY approval place
    // in the mini app (no separate page, no bot buttons). The live box node is
    // re-appended after messages on every chat poll (renderMessages wipes the
    // scroller). Mounts once; re-checks after 1.5s in case Telegram injected
    // the user late (App.state.meId can be a stale preview id on fast boot).
    var joinBoxMounted = false;
    // Holds the live join-requests box node; load() appends it after messages.
    var joinMsgBox = null;
    function freshUid() {
      try {
        var ru = (TG.realUser && TG.realUser()) || null;
        if (ru && Number(ru.id)) return Number(ru.id);
      } catch (e) {}
      return Number(App.state.meId) || 0;
    }
    function maybeMountJoinBox() {
      if (joinBoxMounted) return;
      Api.deal(id)
        .then(function (deal) {
          if (joinBoxMounted || !deal) return;
          var uid = freshUid();
          var isParty = Number(deal.buyer_telegram_id) === uid || Number(deal.seller_telegram_id) === uid;
          var openSlot = !deal.buyer_telegram_id || !deal.seller_telegram_id;
          if (!isParty || !openSlot || UI.isFinalStatus(deal.status)) return;
          joinBoxMounted = true;
          // Not appended anywhere yet: load() moves this live node after the
          // messages on every poll (message-like placement, no top bar).
          joinMsgBox = joinRequestsBox(id, {
            compact: true,
            pollMs: 5000,
            asMessages: true,
            onChange: function () {
              load();
            },
          });
        })
        .catch(function () {
          /* not a party / offline — chat shows its own banner */
        });
    }
    maybeMountJoinBox();
    var joinBoxRetry = setTimeout(maybeMountJoinBox, 1500);
    App.cleanupFns.push(function () {
      try {
        clearTimeout(joinBoxRetry);
      } catch (e) {}
    });
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
    if (m.indexOf('deal_finished') !== -1) return 'Bitim allaqachon yakunlangan';
    if (m.indexOf('deal_locked') !== -1) return "To'lov jarayonda — birozdan keyin urinib ko'ring";
    if (m.indexOf('link_expired') !== -1) return "Havola muddati o'tgan — yangisini so'rang";
    if (m.indexOf('invalid_token') !== -1) return "Havola noto'g'ri";
    if (m.indexOf('deal_has_no_buyer_creator') !== -1 || m.indexOf('deal_has_no_creator') !== -1)
      return "Bitimda yaratuvchi yo'q";
    return "Qo'shilib bo'lmadi — qayta urinib ko'ring";
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
              'Summa ' +
              UI.fmtAmount(deal.amount) +
              ' ' +
              am.symbol +
              ' · Holat: ' +
              UI.statusMeta(deal.status, deal).label,
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
            text: 'Yaratuvchi bitim chati ichida tasdiqlaydi',
          }),
        ]);

        UI.sheetOpen(content, {});

        function doJoin(e) {
          var btn = e && e.currentTarget;
          if (btn) btn.classList.add('is-busy');
          TG.haptic.medium();
          Api.joinDeal(id, token)
            .then(function (res) {
              TG.haptic.success();
              UI.sheetClose();
              if (res && (res.pending || res.requestId)) {
                // Request sent — back to the main page. The bot DMs the joiner
                // on approval, then the deal shows up in their list.
                UI.toast("So'rov yuborildi — tasdiqlangach bot xabar beradi", 'ok');
                go('#/home');
              } else {
                UI.toast("Bitimga qo'shildingiz", 'ok');
                go('#/deal/' + id);
              }
            })
            .catch(function (err) {
              TG.haptic.error();
              UI.toast(joinErrUz(err && err.message), 'err');
              if (btn && FX) FX.shake(btn);
            })
            .then(function () {
              if (btn) btn.classList.remove('is-busy');
            });
        }
      })
      .catch(function (err) {
        box.innerHTML = '';
        if (err && err.status === 410) {
          box.appendChild(
            emptyState(
              '⌛',
              "Havola muddati o'tgan",
              "Bu taklif havolasi eskirgan. Yangisini so'rang.",
              'Bosh sahifa',
              '#/home',
            ),
          );
        } else if (err && err.status === 403) {
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
  function applyThemeMode() {
    try {
      document.body.setAttribute('data-theme-mode', 'dark');
      localStorage.setItem('Savdochi:theme', 'dark');
    } catch (e) {
      /* ignore */
    }
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
                    UI.toast('Hamyon ulanmadi', 'err');
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
              UI.h('div', { class: 'li-icon' }, [UI.icon('router', App.state.apiOk ? 'ico-pulse' : '')]),
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
                  UI.h('div', { class: 'li-icon' }, [UI.icon('badge-check', 'ico-pop')]),
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

  /* ================= Boot ================= */

  function boot() {
    window.addEventListener('error', function () {
      try {
        UI.toast("Xatolik yuz berdi — qayta urinib ko'ring", 'err');
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
    if (/^\d+\.[A-Za-z0-9_-]+$/.test(sp)) {
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
