window.__ModuleLoader__.load({
  id: "dsh-balance-ball",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const reactDom = require("react-dom");

    const ROUTE = "/dsh-account-balance";
    const REFRESH_ROUTE = "/dsh-account-balance/refresh";
    const FALLBACK_INTERVAL_MS = 60000;
    const BALL_SIZE = 56;
    const POP_W = 240;

    function useBalance() {
      const [state, setState] = react.useState({ status: "loading" });
      const intervalRef = react.useRef(FALLBACK_INTERVAL_MS);
      const load = react.useCallback(async (url) => {
        try {
          const res = await fetch(url, { cache: "no-store" });
          const data = await res.json();
          if (data.ok) {
            setState({
              status: "ok",
              balance: data.balance,
              pricing: data.pricing,
              pricingSource: data.pricingSource,
              pricingFetchedAt: data.pricingFetchedAt,
              pricingError: data.pricingError,
            });
            if (data.refreshIntervalMs > 0) intervalRef.current = data.refreshIntervalMs;
          } else {
            setState({ status: "error", message: data.message || data.error });
          }
        } catch (e) {
          setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }, []);
      react.useEffect(() => {
        let cancelled = false, timer;
        const schedule = () => {
          if (cancelled) return;
          // 自动轮询走本地 ROUTE（只刷余额，不触发外网抓价）
          timer = setTimeout(() => load(ROUTE).finally(schedule), intervalRef.current);
        };
        load(ROUTE).finally(schedule);
        return () => { cancelled = true; if (timer !== void 0) clearTimeout(timer); };
      }, [load]);
      return { state, reload: () => load(REFRESH_ROUTE) };
    }

    function fmt(n) { return n.toFixed(2); }
    function fmtTime(ts) {
      if (!ts) return "—";
      const d = new Date(ts);
      const p = (x) => String(x).padStart(2, "0");
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    // ===== 折线图：7-19 时，每小时一条垂直网格线，当前时间圆球超范围贴边缘 =====
    function DayPriceChart({ pricing }) {
      const flash = pricing && pricing["deepseek-flash"];
      if (!flash || !flash.inputPerM) return null;
      const offPeak = flash.inputPerM;
      const peak = offPeak * 2;

      const dow = new Date().getDay();
      const isWorkday = dow >= 1 && dow <= 5;

      // 横轴范围：7 时到 19 时
      const T0 = 7, T1 = 19;
      const W = 300, H = 90, padL = 6, padR = 6, padT = 8, padB = 20;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const xOf = (h) => padL + plotW * ((h - T0) / (T1 - T0));
      const yOf = (isPeak) => isPeak ? padT + plotH * 0.15 : padT + plotH * 0.85;

      const inPeakAt = (h) => isWorkday && ((h >= 9 && h < 12) || (h >= 14 && h < 18));

      const pts = [];
      for (let h = T0; h <= T1; h++) {
        pts.push((h === T0 ? "M" : "L") + xOf(h).toFixed(1) + "," + yOf(inPeakAt(h)).toFixed(1));
      }
      const pathData = pts.join(" ");

      // 每小时一条垂直网格线
      const gridLines = [];
      for (let h = T0; h <= T1; h++) {
        gridLines.push(react.createElement("line", { key: "v" + h, x1: xOf(h), y1: padT, x2: xOf(h), y2: padT + plotH, stroke: "var(--dsw-alias-border-l1)", strokeWidth: 1 }));
      }

      const now = new Date();
      const nowHour = now.getHours() + now.getMinutes() / 60;
      const nowInPeak = inPeakAt(nowHour);
      // 当前时间圆球：超范围（<7 或 >19）贴到对应边缘
      const clampedNowHour = Math.max(T0, Math.min(nowHour, T1));
      const nowX = xOf(clampedNowHour);
      const nowY = yOf(nowInPeak);

      const xTicks = [8, 10, 12, 14, 16, 18].map((h) =>
        react.createElement("text", { key: "xt" + h, x: xOf(h), y: H - 6, textAnchor: "middle", fontSize: 8, fill: "var(--dsw-alias-label-secondary)" }, h)
      );

      const nowDot = react.createElement("circle", { key: "np", cx: nowX, cy: nowY, r: 4, fill: "var(--dsw-alias-brand-primary)" });

      const nowLabel = isWorkday ? (nowInPeak ? "当前：高峰时段" : "当前：空闲时段") : "当前：非工作日（全空闲）";

      return react.createElement("div", { className: "dab-chart-wrap" },
        react.createElement("svg", { width: "100%", viewBox: `0 0 ${W} ${H}`, className: "dab-chart" },
          gridLines, xTicks,
          react.createElement("path", { d: pathData, fill: "none", stroke: "var(--dsw-alias-brand-primary)", strokeWidth: 2, strokeLinejoin: "round" }),
          nowDot
        ),
        react.createElement("div", { className: "dab-now-label" }, nowLabel)
      );
    }

    // ===== 圆形悬浮球（位置状态化 + 边界限制）=====
    function FloatingBall({ state, onToggle, pos, onMove }) {
      const drag = react.useRef({ active: false, moved: false, startX: 0, startY: 0, origLeft: 0, origTop: 0 });

      const onPointerDown = react.useCallback((e) => {
        drag.current = { active: true, moved: false, startX: e.clientX, startY: e.clientY, origLeft: pos.left, origTop: pos.top };
        try { e.target.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      }, [pos]);

      const onPointerMove = react.useCallback((e) => {
        const d = drag.current;
        if (!d.active) return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
        if (d.moved) {
          const vv = window.visualViewport;
          const de = document.documentElement;
          const vw = (vv && vv.width) || de.clientWidth || window.innerWidth;
          const vh = (vv && vv.height) || de.clientHeight || window.innerHeight;
          const maxX = vw - BALL_SIZE;
          const maxY = vh - BALL_SIZE;
          const left = Math.max(0, Math.min(d.origLeft + dx, maxX));
          const top = Math.max(0, Math.min(d.origTop + dy, maxY));
          onMove({ left, top });
        }
      }, [pos, onMove]);

      const onPointerUp = react.useCallback((e) => {
        const d = drag.current;
        if (!d.active) return;
        d.active = false;
        if (!d.moved) onToggle();
      }, [onToggle]);

      let tone = "good", label = "…";
      if (state.status === "ok") {
        const wallets = state.balance?.wallets || [];
        if (wallets.length === 0) { tone = "empty"; label = "0"; }
        else {
          const cny = wallets.find((w) => w.currency === "CNY") || wallets[0];
          const total = cny.total;
          label = total >= 100 ? Math.round(total) + "" : fmt(total);
          tone = total <= 0 ? "empty" : total < 10 ? "low" : "good";
        }
      } else if (state.status === "error") { tone = "empty"; label = "!"; }

      return react.createElement("div", {
        className: "dab-ball dab-tone-" + tone,
        style: { left: pos.left + "px", top: pos.top + "px" },
        onPointerDown,
        onPointerMove,
        onPointerUp,
        title: "余额（可拖动，点击查看详情）",
      },
        react.createElement("div", { className: "dab-ball-highlight" }),
        react.createElement("div", { className: "dab-ball-content" },
          react.createElement("span", { className: "dab-ball-amount" }, label),
          react.createElement("span", { className: "dab-ball-sub" }, "余额")
        )
      );
    }

    // ===== 二级菜单（自适应定位，跟随球移动，可固定）=====
    function Popover({ state, reload, onClose, pos }) {
      const panelRef = react.useRef(null);
      const [pinned, setPinned] = react.useState(false);
      react.useEffect(() => {
        const onDoc = (e) => {
          if (!pinned && panelRef.current && !panelRef.current.contains(e.target)) onClose();
        };
        const onKey = (e) => { if (e.key === "Escape" && !pinned) onClose(); };
        document.addEventListener("mousedown", onDoc);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
      }, [onClose, pinned]);

      // 定位：菜单放在「球上方/下方空间更大」的一侧，固定高度（不动态缩短，球用边界约束保证空间）。
      const style = react.useMemo(() => {
        const ballLeft = pos.left;
        const ballTop = pos.top;
        const ballCenterX = ballLeft + BALL_SIZE / 2;
        const vw = window.innerWidth || document.documentElement.clientWidth;
        const vh = window.innerHeight || document.documentElement.clientHeight;

        // 横向 clamp
        let left = ballCenterX - POP_W / 2;
        left = Math.max(8, Math.min(left, vw - POP_W - 8));

        const gap = 8;
        const ballBottom = ballTop + BALL_SIZE;
        const spaceAbove = ballTop;
        const spaceBelow = vh - ballBottom;

        const placeAbove = spaceAbove >= spaceBelow;
        const s = { left };
        if (placeAbove) {
          s.bottom = vh - ballTop + gap;
        } else {
          s.top = ballBottom + gap;
        }
        return s;
      }, [pos]);

      const head = react.createElement("div", { key: "head", className: "dab-pop-head" },
        react.createElement("span", { className: "dab-pop-title" }, "账户余额"),
        react.createElement("div", { className: "dab-pop-actions" },
          react.createElement("button", {
            className: "dab-pop-pin" + (pinned ? " is-pinned" : ""),
            onClick: () => setPinned((p) => !p),
            title: pinned ? "已固定，点击取消" : "固定菜单（点击其他处不关闭）",
          }, "📌"),
          react.createElement("button", { className: "dab-pop-refresh", onClick: reload }, "刷新")
        )
      );
      const body = [];
      if (state.status === "loading") {
        body.push(react.createElement("div", { key: "l", className: "dab-tip" }, "加载中…"));
      } else if (state.status === "error") {
        body.push(react.createElement("div", { key: "e", className: "dab-err" }, "余额不可用：" + (state.message || "")));
      } else {
        const wallets = state.balance?.wallets || [];
        if (wallets.length === 0) {
          body.push(react.createElement("div", { key: "e", className: "dab-err" }, "暂无余额"));
        } else {
          const cny = wallets.find((w) => w.currency === "CNY") || wallets[0];
          body.push(react.createElement("div", { key: "bal", className: "dab-section" },
            react.createElement("span", { className: "dab-sec-title" }, "可用余额（非 API key）"),
            react.createElement("div", { className: "dab-bal-row" },
              react.createElement("span", { className: "dab-bal-currency" }, cny.currency),
              react.createElement("span", { className: "dab-bal-amount" }, fmt(cny.total))
            ),
            react.createElement("div", { className: "dab-bal-split" },
              react.createElement("span", null, "充值 ", react.createElement("b", null, fmt(cny.toppedUp))),
              react.createElement("span", null, "赠送 ", react.createElement("b", null, fmt(cny.granted)))
            )
          ));
          const others = wallets.filter((w) => w !== cny);
          if (others.length > 0) {
            body.push(react.createElement("div", { key: "other", className: "dab-bal-split" },
              others.map((w) => react.createElement("span", { key: w.currency }, w.currency + " ", react.createElement("b", null, fmt(w.total))))
            ));
          }
          body.push(react.createElement("div", { key: "chart", className: "dab-section" },
            react.createElement("span", { className: "dab-sec-title" }, "今日价格区间"),
            react.createElement(DayPriceChart, { pricing: state.pricing })
          ));
          body.push(react.createElement("div", { key: "price", className: "dab-section" },
            react.createElement("span", { className: "dab-sec-title" }, "当前基准价（未命中·空闲）"),
            react.createElement("table", { className: "dab-price-table" },
              react.createElement("thead", null,
                react.createElement("tr", null,
                  react.createElement("th", { className: "left" }, "模型"),
                  react.createElement("th", { className: "num" }, "输入"),
                  react.createElement("th", { className: "num" }, "输出")
                )
              ),
              react.createElement("tbody", null,
                Object.keys(state.pricing || {}).map((key) => {
                  const p = state.pricing[key];
                  return react.createElement("tr", { key },
                    react.createElement("td", { className: "left" }, p.label),
                    react.createElement("td", { className: "num" }, "¥" + p.inputPerM),
                    react.createElement("td", { className: "num" }, "¥" + p.outputPerM)
                  );
                })
              )
            )
          ));
          // 估算：给出「乐观（全缓存命中）~ 悲观（全未命中）」区间，实际消耗在两者之间
          const estimateRows = Object.keys(state.pricing || {}).map((key) => {
            const p = state.pricing[key];
            const hitInput = p.cacheHitInputPerM ?? p.inputPerM;
            // 乐观：全缓存命中
            const optBlend = hitInput * 0.75 + p.outputPerM * 0.25;
            const optMega = optBlend > 0 ? cny.total / optBlend : Infinity;
            // 悲观：全未命中
            const pesBlend = p.inputPerM * 0.75 + p.outputPerM * 0.25;
            const pesMega = pesBlend > 0 ? cny.total / pesBlend : Infinity;
            return { key, label: p.label, optMega, pesMega };
          });
          body.push(react.createElement("div", { key: "est", className: "dab-section" },
            react.createElement("span", { className: "dab-sec-title" }, "还能用多少 token（估算区间）"),
            estimateRows.map((r) =>
              react.createElement("div", { key: r.key, className: "dab-est-item" },
                react.createElement("span", { className: "dab-est-label" }, r.label),
                react.createElement("span", { className: "dab-est-val" }, fmtMega(r.optMega) + " ~ " + fmtMega(r.pesMega))
              )
            ),
            react.createElement("div", { key: "tip", className: "dab-tip" }, "前者假设全缓存命中，后者全未命中；实际介于两者之间。")
          ));
        }
        const stampText = state.pricingSource === "live"
          ? "价格更新于 " + fmtTime(state.pricingFetchedAt)
          : (state.pricingError ? "价格抓取失败：" + state.pricingError : "价格为兜底参考价");
        body.push(react.createElement("div", { key: "stamp", className: "dab-stamp" }, stampText));
      }
      const bodyEl = react.createElement("div", { key: "body", className: "dab-pop-body" }, body);
      const pop = react.createElement("div", { ref: panelRef, className: "dab-pop", style }, [head, bodyEl]);
      // 用 portal 挂到 body，确保菜单显示在整个页面上层、可超过容器边缘
      return reactDom.createPortal(pop, document.body);
    }

    function fmtMega(m) {
      if (!Number.isFinite(m)) return "∞";
      if (m >= 100) return Math.round(m) + "M tok";
      if (m >= 1) return m.toFixed(1) + "M tok";
      return Math.round(m * 1000) + "K tok";
    }

    function BalanceWidget() {
      const { state, reload } = useBalance();
      const [open, setOpen] = react.useState(false);
      const STORE_KEY = "dsh-balance-ball/pos";
      // 位置状态：优先从 localStorage 恢复上次位置，否则默认右下角
      const [pos, setPos] = react.useState(() => {
        const vv = typeof window !== "undefined" ? window.visualViewport : null;
        const vw = (vv && vv.width) || (typeof window !== "undefined" ? document.documentElement.clientWidth : 0) || (typeof window !== "undefined" ? window.innerWidth : 0);
        const vh = (vv && vv.height) || (typeof window !== "undefined" ? document.documentElement.clientHeight : 0) || (typeof window !== "undefined" ? window.innerHeight : 0);
        const defLeft = vw > 0 ? vw - BALL_SIZE - 20 : 100;
        const defTop = vh > 0 ? vh - BALL_SIZE - 100 : 200;
        // 尝试恢复上次位置（越界则回退默认）
        try {
          const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
          if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
            const maxX = vw - BALL_SIZE;
            const maxY = vh - BALL_SIZE;
            return {
              left: Math.max(0, Math.min(saved.left, maxX)),
              top: Math.max(0, Math.min(saved.top, maxY)),
            };
          }
        } catch (_) {}
        return { left: defLeft, top: defTop };
      });
      const move = react.useCallback((p) => {
        setPos(p);
        // 持久化位置，重启后恢复
        try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch (_) {}
      }, []);
      const close = react.useCallback(() => setOpen(false), []);
      const toggle = react.useCallback(() => setOpen((o) => !o), []);

      return react.createElement(react.Fragment, null,
        reactDom.createPortal(
          react.createElement(FloatingBall, { state, onToggle: toggle, pos, onMove: move }),
          document.body
        ),
        open ? react.createElement(Popover, { state, reload, onClose: close, pos }) : null
      );
    }

    const CSS = `
.dab-ball{position:fixed;z-index:2147483646;width:56px;height:56px;border-radius:50%;cursor:grab;user-select:none;touch-action:none;overflow:hidden;transition:box-shadow .15s}
.dab-ball:hover{box-shadow:0 5px 16px rgba(0,0,0,.28)}
.dab-ball:active{cursor:grabbing}
.dab-ball-highlight{position:absolute;top:5px;left:12px;width:24px;height:12px;border-radius:50%;background:rgba(255,255,255,.28);filter:blur(1px);pointer-events:none}
.dab-ball-content{position:relative;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;pointer-events:none}
.dab-ball-amount{font-size:14px;font-weight:700;color:#fff;font-variant-numeric:tabular-nums;max-width:48px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:-.02em}
.dab-ball-sub{font-size:10px;color:rgba(255,255,255,.95);margin-top:3px;font-weight:600}
.dab-tone-good{background:linear-gradient(180deg,#34d399 0%,#10b981 100%);box-shadow:0 3px 10px rgba(16,185,129,.35),0 1px 3px rgba(0,0,0,.15)}
.dab-tone-good:hover{box-shadow:0 5px 14px rgba(16,185,129,.45),0 2px 4px rgba(0,0,0,.18)}
.dab-tone-low{background:linear-gradient(180deg,#fbbf24 0%,#f59e0b 100%);box-shadow:0 3px 10px rgba(245,158,11,.35),0 1px 3px rgba(0,0,0,.15)}
.dab-tone-low:hover{box-shadow:0 5px 14px rgba(245,158,11,.45),0 2px 4px rgba(0,0,0,.18)}
.dab-tone-empty{background:linear-gradient(180deg,#f87171 0%,#ef4444 100%);box-shadow:0 3px 10px rgba(239,68,68,.35),0 1px 3px rgba(0,0,0,.15)}
.dab-tone-empty:hover{box-shadow:0 5px 14px rgba(239,68,68,.45),0 2px 4px rgba(0,0,0,.18)}
.dab-pop{position:fixed;z-index:2147483647;width:240px;max-width:calc(100vw - 24px);border-radius:12px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv2);overflow:hidden;animation:dab-in .14s ease;max-height:calc(100vh - 80px);overflow-y:auto}
@keyframes dab-in{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
.dab-pop-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dab-pop-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dab-pop-actions{display:flex;align-items:center;gap:6px}
.dab-pop-pin{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;padding:3px 8px;cursor:pointer;white-space:nowrap}
.dab-pop-pin:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dab-pop-pin.is-pinned{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.dab-pop-refresh{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;padding:3px 8px;cursor:pointer;white-space:nowrap}
.dab-pop-refresh:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dab-pop-body{padding:10px 12px;display:flex;flex-direction:column;gap:10px}
.dab-section{display:flex;flex-direction:column;gap:5px}
.dab-sec-title{font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.dab-bal-row{display:flex;align-items:baseline;justify-content:space-between}
.dab-bal-currency{font-size:13px;color:var(--dsw-alias-label-secondary)}
.dab-bal-amount{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}
.dab-bal-split{display:flex;gap:12px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dab-bal-split b{font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dab-chart-wrap{display:flex;flex-direction:column;gap:5px}
.dab-chart{display:block;width:100%;height:auto}
.dab-now-label{font-size:11px;font-weight:600;color:var(--dsw-alias-brand-primary);text-align:center}
.dab-price-table{width:100%;border-collapse:collapse;font-size:12px}
.dab-price-table th,.dab-price-table td{padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dab-price-table th{font-weight:600;color:var(--dsw-alias-label-secondary);font-size:11px}
.dab-price-table th.left,.dab-price-table td.left{text-align:left}
.dab-price-table th.num,.dab-price-table td.num{text-align:right;font-variant-numeric:tabular-nums}
.dab-est-item{display:flex;align-items:center;justify-content:space-between;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.dab-est-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dab-est-val{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dab-tip{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dab-stamp{font-size:11px;color:var(--dsw-alias-label-secondary);text-align:right;border-top:1px solid var(--dsw-alias-border-l1);padding-top:7px}
.dab-err{font-size:12px;color:var(--dsw-alias-state-error-primary)}
`;

    function installStyles() {
      const id = "dsh-account-balance/styles";
      document.querySelector(`style[data-plugin-css="${id}"]`)?.remove();
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-account-balance";
      tag.dataset.pluginCss = id;
      tag.textContent = CSS;
      document.head.append(tag);
      return () => tag.remove();
    }

    const inject = ["slots"];

    function apply(ctx) {
      ctx.effect(installStyles, "dsh-account-balance: styles");
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          {
            name: "shell.overlay",
            id: "account-balance",
            order: 1000,
            priority: 0,
            locale: null,
            inject: () => ({}),
          },
          BalanceWidget
        )
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
