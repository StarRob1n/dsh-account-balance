/**
 * dsh-account-balance — host half.
 *
 * 1. 从 DSH 官方的 deepseekAccount 服务读取账号余额（OAuth 登录专用）。
 * 2. 从 DeepSeek 官方定价页（pricing.md）定期抓取实时价格，失败时回退兜底价。
 * 通过同源 GET 路由返回给浏览器端；/refresh 端点强制重新抓价。
 */

const ROUTE = "/dsh-account-balance";
const REFRESH_ROUTE = "/dsh-account-balance/refresh";
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;   // 浏览器端余额+价格轮询间隔：1 分钟
const PRICING_FETCH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 价格抓取间隔：6 小时
const PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md";

// 兜底价（每百万 tokens，元）。仅在官方页面抓取失败时使用。
const FALLBACK_PRICING = {
  "deepseek-flash": { label: "Flash (V4.1)", inputPerM: 1, cacheHitInputPerM: 0.02, outputPerM: 4 },
  "deepseek-v4-pro": { label: "Pro (V4)", inputPerM: 4.5, cacheHitInputPerM: 0.15, outputPerM: 13.5 },
};

const inject = ["webServer"];

function apply(ctx, config) {
  const refreshIntervalMs =
    typeof config?.refreshIntervalMs === "number" && config.refreshIntervalMs > 0
      ? config.refreshIntervalMs
      : DEFAULT_REFRESH_INTERVAL_MS;

  // 价格缓存：启动即抓一次，之后定时刷新。
  let pricingCache = { ...FALLBACK_PRICING };
  let pricingSource = "fallback";
  let pricingFetchedAt = null;
  let pricingError = null;

  async function refreshPricing() {
    try {
      const fetched = await fetchPricing();
      pricingCache = fetched;
      pricingSource = "live";
      pricingFetchedAt = Date.now();
      pricingError = null;
    } catch (e) {
      // 抓取失败：保留兜底价，记录失败原因和时间
      pricingSource = "fallback";
      pricingFetchedAt = Date.now();
      pricingError = e instanceof Error ? e.message : String(e);
    }
  }

  // 启动时抓一次（不阻塞路由注册）
  refreshPricing();
  const timer = setInterval(refreshPricing, PRICING_FETCH_INTERVAL_MS);

  function buildPayload() {
    return {
      pricing: pricingCache,
      pricingSource,
      pricingFetchedAt,
      pricingError,
      refreshIntervalMs,
    };
  }

  ctx.effect(
    () => {
      // 主路由：返回余额 + 价格
      const unregister1 = ctx.webServer.register({
        kind: "exact",
        path: ROUTE,
        handler: async (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { allow: "GET, HEAD" });
            res.end();
            return;
          }
          try {
            const account = ctx.get("deepseekAccount", false);
            if (!account || typeof account.getBalance !== "function") {
              sendJson(res, 200, {
                ok: false,
                error: "no-account-service",
                message: "当前 DSH 未提供 deepseekAccount 服务",
              });
              return;
            }
            const snapshot = await account.getBalance(accountClientMetadata());
            const parsed = parseAccountBalance(snapshot);
            sendJson(res, 200, {
              ok: true,
              balance: parsed,
              ...buildPayload(),
            });
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              error: "fetch-error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });

      // 刷新路由：强制重新抓价，然后返回余额 + 价格
      const unregister2 = ctx.webServer.register({
        kind: "exact",
        path: REFRESH_ROUTE,
        handler: async (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { allow: "GET, HEAD" });
            res.end();
            return;
          }
          try {
            await refreshPricing();
            const account = ctx.get("deepseekAccount", false);
            if (!account || typeof account.getBalance !== "function") {
              sendJson(res, 200, {
                ok: false,
                error: "no-account-service",
                message: "当前 DSH 未提供 deepseekAccount 服务",
              });
              return;
            }
            const snapshot = await account.getBalance(accountClientMetadata());
            const parsed = parseAccountBalance(snapshot);
            sendJson(res, 200, {
              ok: true,
              balance: parsed,
              ...buildPayload(),
            });
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              error: "fetch-error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });

      return () => {
        unregister1?.();
        unregister2?.();
      };
    },
    "dsh-account-balance: routes",
  );

  return () => clearInterval(timer);
}

/**
 * 抓取并解析官方 pricing.md。
 * 解析两个模型的价格表，返回完整 6 档价格序列。
 */
async function fetchPricing() {
  const res = await fetch(PRICING_URL, {
    headers: { "user-agent": "dsh-account-balance/0.1.0" },
  });
  if (!res.ok) throw new Error("pricing fetch HTTP " + res.status);
  const md = await res.text();

  // 用 Unicode 转义 \u5143 = "元"，正则匹配 "数字元" 两个相邻价格单元格。
  // 6 对顺序：(缓存命中空闲, 缓存命中高峰, 未命中空闲, 未命中高峰, 输出空闲, 输出高峰)
  const pairs = [];
  const re = /\|\s*(\d+(?:\.\d+)?)\u5143\s*\|\s*(\d+(?:\.\d+)?)\u5143\s*\|/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    pairs.push([Number(m[1]), Number(m[2])]);
  }

  if (pairs.length < 5) {
    throw new Error("pricing parse incomplete: " + pairs.length + " pairs");
  }

  const buildModel = (label, idx) => ({
    label,
    inputPerM: pairs[2][idx],        // 未命中·空闲输入价
    cacheHitInputPerM: pairs[0][idx], // 缓存命中·空闲输入价
    outputPerM: pairs[4][idx],        // 输出·空闲价
  });

  return {
    "deepseek-flash": buildModel("Flash (V4.1)", 0),
    "deepseek-v4-pro": buildModel("Pro (V4)", 1),
  };
}

/** 账号服务要求的调用方身份。 */
function accountClientMetadata() {
  return {
    version: "0.1.0",
    locale: "zh-CN",
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  };
}

/** 账号余额快照 → 规范化结果。total = 充值钱包 + 赠送钱包。 */
function parseAccountBalance(snapshot) {
  if (!snapshot) throw new Error("账号未登录");
  if (snapshot.status !== "ready") throw new Error("账号余额查询失败");

  const value = Array.isArray(snapshot.value) ? snapshot.value : [];
  const bonus = Array.isArray(snapshot.bonusWallets) ? snapshot.bonusWallets : [];

  const toppedUpBy = new Map();
  for (const w of value) {
    const currency = typeof w?.currency === "string" && w.currency ? w.currency : "CNY";
    toppedUpBy.set(currency, (toppedUpBy.get(currency) ?? 0) + toNumber(w?.balance));
  }
  const grantedBy = new Map();
  for (const w of bonus) {
    const currency = typeof w?.currency === "string" && w.currency ? w.currency : "CNY";
    grantedBy.set(currency, (grantedBy.get(currency) ?? 0) + toNumber(w?.balance));
  }
  for (const c of grantedBy.keys()) {
    if (!toppedUpBy.has(c)) toppedUpBy.set(c, 0);
  }

  const wallets = [...toppedUpBy.entries()].map(([currency, toppedUp]) => {
    const granted = grantedBy.get(currency) ?? 0;
    return {
      currency,
      total: round2(granted + toppedUp),
      granted: round2(granted),
      toppedUp: round2(toppedUp),
    };
  });

  return { wallets };
}

function toNumber(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export { ROUTE, apply, inject };
