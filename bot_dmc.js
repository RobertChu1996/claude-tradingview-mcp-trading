/**
 * Strategy B: DMC — SMA25 + Volume + Candle Strength (4H)
 * 最優化參數（2026-05-29 網格搜索）：
 *   SMA=25, VolRatio=1.5, Strength=0.7, SwingLB=8, ATRx=0.05, TP=3:1
 * 回測結果（OKX 4H, ~9個月, 48幣）：PF=2.09, 勝率=40%, MDD=4.2%, 淨PnL=+$257
 * 每15分鐘掃一次，模擬盤模式
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import {
  POSITIONS_DMC_FILE  as POSITIONS_FILE,
  LOG_DMC_FILE        as LOG_FILE,
  CSV_DMC_FILE        as CSV_FILE,
  WATCHLIST_DMC_FILE,
} from "./paths.js";

// ─── 策略參數（優化後）────────────────────────────────────────────────────────
const SMA_PERIOD      = 25;
const VOL_RATIO       = 1.5;
const STRENGTH        = 0.7;
const SWING_LB        = 8;
const ATR_MULT        = 0.05;
const TP_RATIO        = 3.0;
const SMA_PREV_OFFSET = 5;   // 用幾根前的SMA判斷趨勢方向
const COOLDOWN_BARS   = 2;   // 止損/止盈後冷卻 2 根4H棒（= 8小時）
const MIN_PRICE       = 0.001; // 微價幣過濾（PEPE/SHIB等浮點問題）

const CONFIG = {
  paperTrading:    process.env.DMC_PAPER_TRADING !== "false",
  portfolioValue:  parseFloat(process.env.PORTFOLIO_VALUE_USD  || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD   || "200"),
  riskPct:         parseFloat(process.env.RISK_PCT             || "0.01"),
  maxOpen:         parseInt  (process.env.DMC_MAX_OPEN         || "4"),
  dailyLossLimitPct: parseFloat(process.env.DAILY_LOSS_LIMIT_PCT || "0.05"),
  okx: {
    apiKey:     process.env.OKX_API_KEY,
    secretKey:  process.env.OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE,
    baseUrl:    process.env.OKX_BASE_URL || "https://www.okx.com",
  },
};

const FALLBACK_SYMBOLS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","AVAXUSDT","DOGEUSDT","DOTUSDT","LINKUSDT",
  "LTCUSDT","NEARUSDT","UNIUSDT","AAVEUSDT","ATOMUSDT",
  "FILUSDT","ETCUSDT","XLMUSDT","ZILUSDT","WLDUSDT",
  "HBARUSDT","SEIUSDT","STRKUSDT","ZKUSDT","BIOUSDT",
  "CHZUSDT","GMTUSDT","RSRUSDT","PEOPLEUSDT","IOSTUSDT",
];

function loadSymbols() {
  if (existsSync(WATCHLIST_DMC_FILE)) {
    try {
      const wl = JSON.parse(readFileSync(WATCHLIST_DMC_FILE, "utf8"));
      if (Array.isArray(wl.symbols) && wl.symbols.length > 0) {
        log(`[DMC] 動態清單 ${wl.symbols.length} 幣（更新於 ${wl.updatedAt?.slice(0,10)}）`);
        return wl.symbols;
      }
    } catch {}
  }
  log(`[DMC] 使用靜態兜底清單 ${FALLBACK_SYMBOLS.length} 幣`);
  return FALLBACK_SYMBOLS;
}

const CSV_HEADERS = "Date,Time(UTC),Symbol,Side,Entry,Exit,PnL,Reason,Mode,OrderID";

// ─── 工具函式 ─────────────────────────────────────────────────────────────────
function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return { open: [], closed: [], cooldown: {} };
  try { return JSON.parse(readFileSync(POSITIONS_FILE, "utf8")); }
  catch { return { open: [], closed: [], cooldown: {} }; }
}
function savePositions(p) {
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  p.closed = (p.closed || []).filter(t => t.exitTime > cutoff);
  writeFileSync(POSITIONS_FILE, JSON.stringify(p, null, 2));
}
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}
function initCsv() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
}
function appendCsv(pos, exitPrice, pnl, reason) {
  const d = new Date().toISOString();
  writeFileSync(CSV_FILE,
    `${d.slice(0,10)},${d.slice(11,19)},${pos.symbol},${pos.side},` +
    `${pos.entryPrice},${exitPrice?.toFixed(6) ?? ""},${pnl?.toFixed(2) ?? ""},` +
    `${reason},${CONFIG.paperTrading?"PAPER":"LIVE"},${pos.orderId}\n`,
    { flag: "a" }
  );
}
function getTodayLoss() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (!existsSync(CSV_FILE)) return 0;
    let loss = 0;
    for (const line of readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1)) {
      if (!line) continue;
      const p = line.split(",");
      if (p[0] !== today || p[7] === "開倉") continue;
      const pnl = parseFloat(p[6]);
      if (!isNaN(pnl) && pnl < 0) loss += Math.abs(pnl);
    }
    return loss;
  } catch { return 0; }
}

// ─── 市場資料 ─────────────────────────────────────────────────────────────────
function toOkxInstId(sym) {
  for (const q of ["USDT","USDC","BTC","ETH"])
    if (sym.endsWith(q)) return `${sym.slice(0,-q.length)}-${q}`;
  return sym;
}

async function fetchCandles4H(symbol, limit = 350) {
  const instId = toOkxInstId(symbol);
  const url    = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=4H&limit=${Math.min(limit,300)}`;
  const res    = await fetch(url);
  if (!res.ok) throw new Error(`OKX ${res.status}`);
  const data   = await res.json();
  if (!data.data?.length) throw new Error(`OKX no data for ${symbol}`);
  return data.data.reverse().map(k => ({
    time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5],
  }));
}

function completed4H(candles) {
  const h4ms = 4 * 3600 * 1000;
  const curBarOpen = Math.floor(Date.now() / h4ms) * h4ms;
  return candles.filter(c => c.time < curBarOpen);
}

// ─── 指標 ─────────────────────────────────────────────────────────────────────
function smaOf(closes, n) {
  return closes.slice(-n).reduce((a,b)=>a+b,0) / n;
}
function atrOf(candles, n=14) {
  const trs = candles.slice(1).map((c,i)=>{
    const p = candles[i].close;
    return Math.max(c.high-c.low, Math.abs(c.high-p), Math.abs(c.low-p));
  });
  return trs.slice(-n).reduce((a,b)=>a+b,0)/n;
}
function avgVolOf(candles, n=20) {
  return candles.slice(-n).reduce((s,c)=>s+c.volume,0)/n;
}
function swingLowOf(candles, lb) {
  return Math.min(...candles.slice(-lb-1,-1).map(c=>c.low));
}
function swingHighOf(candles, lb) {
  return Math.max(...candles.slice(-lb-1,-1).map(c=>c.high));
}

// ─── BTC 趨勢方向（用於過濾逆勢信號）────────────────────────────────────────
function btcTrendDir(candles) {
  if (candles.length < SMA_PERIOD + SMA_PREV_OFFSET) return 0;
  const closes  = candles.map(c => c.close);
  const smaNow  = smaOf(closes, SMA_PERIOD);
  const smaPrev = smaOf(closes.slice(0, -SMA_PREV_OFFSET), SMA_PERIOD);
  if (smaNow > smaPrev * 1.001) return  1;  // 上漲
  if (smaNow < smaPrev * 0.999) return -1;  // 下跌
  return 0;                                  // 橫盤（允許雙向）
}

// ─── 進場信號 ─────────────────────────────────────────────────────────────────
function checkSignal(candles) {
  if (candles.length < SMA_PERIOD + SMA_PREV_OFFSET + 10) return null;
  const closes = candles.map(c=>c.close);
  const price  = closes[closes.length-1];
  const smaNow  = smaOf(closes, SMA_PERIOD);
  const smaPrev = smaOf(closes.slice(0, -SMA_PREV_OFFSET), SMA_PERIOD);
  const last    = candles[candles.length-1];
  const volR    = last.volume / avgVolOf(candles, 20);
  const body    = Math.abs(last.close - last.open);
  const range   = last.high - last.low || 0.0001;
  const strength = body / range;
  const rec3    = closes.slice(-3).reduce((a,b)=>a+b,0)/3;
  const prev3   = closes.slice(-6,-3).reduce((a,b)=>a+b,0)/3;
  const atr     = atrOf(candles, 14);

  // 微價幣過濾
  if (price < MIN_PRICE) return null;

  // Long
  if (smaNow > smaPrev && price > smaNow && volR > VOL_RATIO &&
      last.close > last.open && strength > STRENGTH && rec3 > prev3) {
    const sl    = swingLowOf(candles, SWING_LB) - atr * ATR_MULT;
    const slPct = (price - sl) / price;
    if (sl >= price || slPct < 0.003 || slPct > 0.15) return null;
    const tp = price + (price - sl) * TP_RATIO;
    return { side:"long", entry:price, sl, tp, slPct };
  }
  // Short
  if (smaNow < smaPrev && price < smaNow && volR > VOL_RATIO &&
      last.close < last.open && strength > STRENGTH && rec3 < prev3) {
    const sl    = swingHighOf(candles, SWING_LB) + atr * ATR_MULT;
    const slPct = (sl - price) / price;
    if (sl <= price || slPct < 0.003 || slPct > 0.15) return null;
    const tp = price - (sl - price) * TP_RATIO;
    if (tp <= 0) return null;
    return { side:"short", entry:price, sl, tp, slPct };
  }
  return null;
}

// ─── 追蹤止損（以 R 倍數鎖利）────────────────────────────────────────────────
function calcTrailingSL(pos, price) {
  const risk = Math.abs(pos.entryPrice - pos.currentSL);
  if (!risk) return pos.currentSL;
  const profit  = pos.side==="long" ? price-pos.entryPrice : pos.entryPrice-price;
  const profitR = profit / risk;
  if (profitR < 1) return pos.currentSL;
  const lockR = Math.max(0, Math.floor(profitR*2)/2 - 1.0);
  const ns = pos.side==="long"
    ? pos.entryPrice + risk*lockR
    : pos.entryPrice - risk*lockR;
  return pos.side==="long" ? Math.max(pos.currentSL, ns) : Math.min(pos.currentSL, ns);
}

// ─── Paper 出場模擬 ───────────────────────────────────────────────────────────
async function checkPaperExit(pos) {
  try {
    const raw  = await fetchCandles4H(pos.symbol, 5);
    const c    = completed4H(raw);
    if (!c.length) return null;
    const last    = c[c.length-1];
    const isShort = pos.side==="short";
    const slHit   = isShort ? last.high >= pos.currentSL : last.low  <= pos.currentSL;
    const tpHit   = isShort ? last.low  <= pos.tp        : last.high >= pos.tp;
    if (slHit && tpHit) {
      const tpFirst = isShort ? last.close < last.open : last.close > last.open;
      return tpFirst
        ? { reason:"止盈", price:pos.tp }
        : { reason:"止損", price:pos.currentSL };
    }
    if (slHit) return { reason:"止損", price:pos.currentSL };
    if (tpHit) return { reason:"止盈", price:pos.tp };
    return null;
  } catch { return null; }
}

// ─── OKX API（Live 用）───────────────────────────────────────────────────────
function sign(ts, method, path, body="") {
  return crypto.createHmac("sha256", CONFIG.okx.secretKey)
    .update(`${ts}${method}${path}${body}`).digest("base64");
}
async function okxPost(path, bodyObj) {
  const ts   = new Date().toISOString();
  const body = JSON.stringify(bodyObj);
  const res  = await fetch(`${CONFIG.okx.baseUrl}${path}`, {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "OK-ACCESS-KEY":CONFIG.okx.apiKey,
      "OK-ACCESS-SIGN":sign(ts,"POST",path,body),
      "OK-ACCESS-TIMESTAMP":ts,
      "OK-ACCESS-PASSPHRASE":CONFIG.okx.passphrase,
    },
    body,
  });
  return res.json();
}
async function okxGet(path) {
  const ts  = new Date().toISOString();
  const res = await fetch(`${CONFIG.okx.baseUrl}${path}`, {
    headers:{
      "OK-ACCESS-KEY":CONFIG.okx.apiKey,
      "OK-ACCESS-SIGN":sign(ts,"GET",path),
      "OK-ACCESS-TIMESTAMP":ts,
      "OK-ACCESS-PASSPHRASE":CONFIG.okx.passphrase,
    },
  });
  return res.json();
}

const _specCache = {};
async function fetchSpec(instId) {
  if (_specCache[instId]) return _specCache[instId];
  const d    = await okxGet(`/api/v5/public/instruments?instType=SWAP&instId=${instId}`);
  const inst = d.data?.[0];
  if (!inst) throw new Error(`找不到合約: ${instId}`);
  const spec = { ctVal:+inst.ctVal, minSz:+inst.minSz, lotSz:+inst.lotSz };
  _specCache[instId] = spec;
  return spec;
}
function floorLot(v, lotSz) {
  const f = Math.pow(10, Math.round(-Math.log10(lotSz)));
  return Math.floor(v*f)/f;
}

async function fetchPortfolioValue() {
  if (!CONFIG.paperTrading) {
    try {
      const res  = await okxGet("/api/v5/account/balance");
      const usdt = res.data?.[0]?.details?.find(d => d.ccy === "USDT");
      if (usdt) {
        const eq = parseFloat(usdt.eq);
        log(`[DMC] 帳戶餘額 (OKX): $${eq.toFixed(4)}`);
        return eq;
      }
    } catch(e) {
      log(`⚠️ OKX 餘額查詢失敗，使用設定值: ${e.message}`);
    }
  }
  // Paper mode or API failure fallback
  const pos = loadPositions();
  const closedPnl = (pos.closed || []).reduce((s, t) => s + (t.pnl || 0), 0);
  return CONFIG.portfolioValue + closedPnl;
}

async function placeEntry(symbol, sig, portfolioValue) {
  const instId  = toOkxInstId(symbol) + "-SWAP";
  const spec    = await fetchSpec(instId);
  const riskUSD = portfolioValue * CONFIG.riskPct;
  const rawSz   = riskUSD / sig.slPct / sig.entry / spec.ctVal;
  const sz      = String(floorLot(Math.min(rawSz, CONFIG.maxTradeSizeUSD/sig.entry/spec.ctVal), spec.lotSz));
  if (+sz < spec.minSz) throw new Error(`倉位太小 ${sz} < ${spec.minSz}`);
  const isShort = sig.side==="short";
  const entryRes = await okxPost("/api/v5/trade/order", {
    instId, tdMode:"isolated",
    side: isShort?"sell":"buy", posSide: isShort?"short":"long",
    ordType:"market", sz,
  });
  if (entryRes.code !== "0") throw new Error(`進場失敗: ${entryRes.msg}`);
  const orderId = entryRes.data?.[0]?.ordId;
  const ocoRes  = await okxPost("/api/v5/trade/order-algo", {
    instId, tdMode:"isolated",
    side: isShort?"buy":"sell", posSide: isShort?"short":"long",
    ordType:"oco", sz,
    slTriggerPx: sig.sl.toFixed(8), slOrdPx:"-1", slTriggerPxType:"last",
    tpTriggerPx: sig.tp.toFixed(8), tpOrdPx:"-1", tpTriggerPxType:"last",
  });
  if (ocoRes.code !== "0") throw new Error(`OCO失敗: ${ocoRes.msg}`);
  return { orderId, algoId:ocoRes.data?.[0]?.algoId };
}

async function placeOCO(instId, isShort, sz, sl, tp) {
  return okxPost("/api/v5/trade/order-algo", {
    instId, tdMode: "isolated",
    side: isShort ? "buy" : "sell", posSide: isShort ? "short" : "long",
    ordType: "oco", sz,
    slTriggerPx: sl.toFixed(8), slOrdPx: "-1", slTriggerPxType: "last",
    tpTriggerPx: tp.toFixed(8), tpOrdPx: "-1", tpTriggerPxType: "last",
  });
}

async function closePosition(instId, isShort, sz) {
  return okxPost("/api/v5/trade/order", {
    instId, tdMode: "isolated",
    side: isShort ? "buy" : "sell", posSide: isShort ? "short" : "long",
    ordType: "market", sz,
  });
}

async function updateOCO(pos, newSL) {
  const instId  = toOkxInstId(pos.symbol) + "-SWAP";
  const spec    = await fetchSpec(instId);
  const sz      = String(floorLot(pos.quantity / spec.ctVal, spec.lotSz));
  const isShort = pos.side === "short";

  await okxPost("/api/v5/trade/cancel-algos", [{ algoId: pos.algoId, instId }]);

  // Attempt new OCO; retry once on failure; emergency-close if both fail
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ocoRes = await placeOCO(instId, isShort, sz, newSL, pos.tp);
    if (ocoRes.code === "0") return ocoRes.data?.[0]?.algoId;
    log(`⚠️ updateOCO 第${attempt}次失敗 ${pos.symbol}: ${ocoRes.msg}`);
    if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
  }

  // Both attempts failed — position now has no SL; close immediately to cap risk
  log(`🚨 updateOCO 連續失敗，緊急平倉 ${pos.symbol} 以保護資金`);
  const closeRes = await closePosition(instId, isShort, sz);
  if (closeRes.code !== "0") log(`🚨 緊急平倉也失敗: ${closeRes.msg}`);
  throw new Error(`OCO更新失敗，已緊急平倉 ${pos.symbol}`);
}

async function checkAlgoStatus(algoId, instId) {
  const res   = await okxGet(`/api/v5/trade/order-algo?ordType=oco&algoId=${algoId}&instId=${instId}`);
  const state = res.data?.[0]?.state;

  // If algo is clearly still active, no need to check positions
  if (state === "live" || state === "effective" || state === "partially_effective") return state;

  // For all other cases (filled/cancelled/stopped/null), verify via actual OKX position.
  // This prevents false-closes when a stale algoId (from trailing-SL updates) returns "cancelled"
  // while the position is still genuinely open.
  const posRes = await okxGet(`/api/v5/account/positions?instId=${instId}`);
  const hasPos = posRes.data?.some(p => parseFloat(p.pos) !== 0);
  if (hasPos) return undefined;   // position still exists on OKX → don't close in state
  return "filled";                // no OKX position → truly closed
}

// ─── 啟動對帳：比對 OKX 實際持倉與 state，修復不一致 ───────────────────────
async function reconcileWithOKX(positions) {
  if (CONFIG.paperTrading) return;
  try {
    const [posRes, algoRes, specAllRes] = await Promise.all([
      okxGet("/api/v5/account/positions?instType=SWAP"),
      okxGet("/api/v5/trade/orders-algo-pending?ordType=oco&instType=SWAP"),
      okxGet("/api/v5/public/instruments?instType=SWAP"),
    ]);

    // instId → OKX position
    const okxMap = {};
    for (const p of posRes.data || [])
      if (parseFloat(p.pos) !== 0) okxMap[p.instId] = p;

    // instId → active OCO {algoId, sl, tp}
    const algoMap = {};
    for (const a of algoRes.data || [])
      algoMap[a.instId] = { algoId: a.algoId, sl: parseFloat(a.slTriggerPx), tp: parseFloat(a.tpTriggerPx) };

    // instId → contract spec {ctVal}
    const specMap = {};
    for (const s of specAllRes.data || [])
      specMap[s.instId] = { ctVal: parseFloat(s.ctVal) };

    let changed = false;
    const now = Date.now();

    // Direction 1: state.open position missing from OKX → mark closed
    for (const pos of [...positions.open]) {
      const instId = toOkxInstId(pos.symbol) + "-SWAP";
      if (okxMap[instId]) {
        // Refresh stale algoId if a newer OCO is active for this position
        if (algoMap[instId] && algoMap[instId].algoId !== pos.algoId) {
          log(`[reconcile] ${pos.symbol} 更新 algoId ${pos.algoId} → ${algoMap[instId].algoId}`);
          pos.algoId = algoMap[instId].algoId;
          changed = true;
        }
      } else {
        log(`[reconcile] ⚠️ ${pos.symbol} 不在 OKX 持倉，標記平倉`);
        positions.closed.push({ ...pos, exitTime: now, exitState: "reconcile", pnl: null });
        positions.cooldown[pos.symbol] = now;
        positions.open = positions.open.filter(p => p !== pos);
        changed = true;
      }
    }

    // Direction 2: OKX position not in state.open → restore from OKX data
    const stateSymbols = new Set(positions.open.map(p => toOkxInstId(p.symbol) + "-SWAP"));
    for (const [instId, okxPos] of Object.entries(okxMap)) {
      if (stateSymbols.has(instId)) continue;
      const sym     = instId.replace("-SWAP", "").replace(/-/g, "");
      const side    = okxPos.posSide;
      const entry   = parseFloat(okxPos.avgPx);
      const ctVal   = specMap[instId]?.ctVal ?? 1;
      const qty     = Math.abs(parseFloat(okxPos.pos)) * ctVal;
      const oco     = algoMap[instId];
      const restoredPos = {
        symbol:    sym,
        side,
        entryPrice: entry,
        initialSL:  oco?.sl ?? null,
        currentSL:  oco?.sl ?? null,
        tp:         oco?.tp ?? null,
        quantity:   qty,
        entryTime:  okxPos.cTime ? parseInt(okxPos.cTime) : now,
        orderId:    okxPos.tradeId ?? `RECONCILE-${now}`,
        algoId:     oco?.algoId ?? null,
      };
      log(`[reconcile] ⚠️ ${sym}(${side}) 在 OKX 但不在 state，自動補回 entry=$${entry}`);
      positions.open.push(restoredPos);
      changed = true;
    }

    if (changed) log("[reconcile] state 已對帳更新");
    else         log("[reconcile] state 與 OKX 一致，無需修正");
  } catch(e) {
    log(`⚠️ 對帳失敗: ${e.message}`);
  }
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────
async function run() {
  initCsv();
  const positions = loadPositions();
  if (!positions.cooldown) positions.cooldown = {};
  const now = Date.now();

  const portfolioValue = await fetchPortfolioValue();
  log(`[DMC] 開始 | 模式:${CONFIG.paperTrading?"PAPER":"LIVE"} | 開倉:${positions.open.length}/${CONFIG.maxOpen} | 資產:$${portfolioValue.toFixed(2)}`);

  // 啟動對帳：確保 state 與 OKX 實際持倉一致
  await reconcileWithOKX(positions);

  if (!CONFIG.paperTrading) {
    const paperOpen = positions.open.filter(p=>p.orderId?.startsWith("DMC-PAPER-"));
    if (paperOpen.length > 0) {
      log(`⚠️ 偵測到 PAPER→LIVE 切換，清除 ${paperOpen.length} 筆模擬倉位`);
      positions.open = positions.open.filter(p=>!p.orderId?.startsWith("DMC-PAPER-"));
      savePositions(positions);
      return;
    }
  }

  // Step 1：檢查出場
  for (const pos of [...positions.open]) {
    if (CONFIG.paperTrading) {
      const exit = await checkPaperExit(pos);
      if (exit) {
        const sign = pos.side==="short" ? -1 : 1;
        const pnl  = sign * (exit.price - pos.entryPrice) * pos.quantity;
        log(`[DMC][PAPER] 出場 ${pos.symbol}(${pos.side}) ${exit.reason} $${exit.price.toFixed(4)} PnL $${pnl.toFixed(2)}`);
        appendCsv(pos, exit.price, pnl, exit.reason);
        positions.closed.push({ ...pos, exitTime:now, exitPrice:exit.price, pnl });
        positions.cooldown[pos.symbol] = now;
        positions.open = positions.open.filter(p=>p!==pos);
      }
    } else {
      try {
        const instId = toOkxInstId(pos.symbol) + "-SWAP";
        const state  = await checkAlgoStatus(pos.algoId, instId);
        if (state==="filled"||state==="cancelled"||state==="stopped") {
          log(`[DMC] 出場確認 ${pos.symbol} state=${state}`);
          appendCsv(pos, null, null, state);
          positions.closed.push({ ...pos, exitTime:now, exitState:state });
          positions.cooldown[pos.symbol] = now;
          positions.open = positions.open.filter(p=>p!==pos);
        }
      } catch(e) { log(`⚠️ 查詢OCO失敗 ${pos.symbol}: ${e.message}`); }
    }
  }

  // Step 2：更新追蹤止損
  for (const pos of positions.open) {
    try {
      const raw   = await fetchCandles4H(pos.symbol, 5);
      const c     = completed4H(raw);
      if (!c.length) continue;
      const price = c[c.length-1].close;
      const newSL = calcTrailingSL(pos, price);
      const moved = pos.side==="long" ? newSL>pos.currentSL : newSL<pos.currentSL;
      if (moved) {
        log(`[DMC] 追蹤止損移動 ${pos.symbol}(${pos.side}): $${pos.currentSL.toFixed(6)} → $${newSL.toFixed(6)}`);
        if (CONFIG.paperTrading) {
          pos.currentSL = newSL;
        } else {
          const newAlgoId = await updateOCO(pos, newSL);
          pos.currentSL = newSL;
          pos.algoId    = newAlgoId;
        }
      }
    } catch(e) { log(`⚠️ 更新止損失敗 ${pos.symbol}: ${e.message}`); }
  }

  // Step 3：掃描新信號
  if (positions.open.length >= CONFIG.maxOpen) {
    log(`[DMC] 已滿倉 (${positions.open.length}/${CONFIG.maxOpen})，跳過掃描`);
    savePositions(positions);
    return;
  }

  const todayLoss      = getTodayLoss();
  const dailyLossLimit = portfolioValue * CONFIG.dailyLossLimitPct;
  if (todayLoss >= dailyLossLimit) {
    log(`[DMC] ⚠️ 每日虧損熔斷 $${todayLoss.toFixed(2)} >= $${dailyLossLimit.toFixed(2)}，今日停止開倉`);
    savePositions(positions);
    return;
  }

  const SYMBOLS = loadSymbols();
  log(`[DMC] 掃描 ${SYMBOLS.length} 幣種... 今日損失 $${todayLoss.toFixed(2)}/$${dailyLossLimit.toFixed(2)}`);

  // 取得 BTC 趨勢方向（一次性，供所有幣種過濾使用）
  let btcTrend = 0;
  try {
    const btcRaw = await fetchCandles4H("BTCUSDT", SMA_PERIOD + SMA_PREV_OFFSET + 10);
    btcTrend = btcTrendDir(completed4H(btcRaw));
    log(`[DMC] BTC 趨勢: ${btcTrend === 1 ? "上漲↑（只做多）" : btcTrend === -1 ? "下跌↓（只做空）" : "橫盤→（雙向）"}`);
  } catch(e) {
    log(`⚠️ BTC 趨勢取得失敗，跳過過濾: ${e.message}`);
  }

  const cooldownMs = COOLDOWN_BARS * 4 * 3600 * 1000;

  for (const symbol of SYMBOLS) {
    if (positions.open.length >= CONFIG.maxOpen) break;
    if (positions.open.some(p=>p.symbol===symbol)) continue;

    // 冷卻期：止損/止盈後 COOLDOWN_BARS 根4H棒內不重進
    const lastExit = positions.cooldown[symbol];
    if (lastExit && now - lastExit < cooldownMs) continue;

    try {
      const raw = await fetchCandles4H(symbol, SMA_PERIOD + SMA_PREV_OFFSET + 30);
      const c   = completed4H(raw);
      const sig = checkSignal(c);
      if (!sig) continue;

      // BTC 趨勢過濾：上漲時不做空，下跌時不做多
      if (btcTrend === 1 && sig.side === "short") {
        log(`[DMC] 跳過 ${symbol}(short)：BTC 上漲趨勢`);
        continue;
      }
      if (btcTrend === -1 && sig.side === "long") {
        log(`[DMC] 跳過 ${symbol}(long)：BTC 下跌趨勢`);
        continue;
      }

      log(`[DMC] 信號 ${symbol}(${sig.side}) | SL $${sig.sl.toFixed(4)} | TP $${sig.tp.toFixed(4)} | SL% ${(sig.slPct*100).toFixed(2)}%`);

      const riskUSD  = portfolioValue * CONFIG.riskPct;
      const quantity = Math.min(riskUSD / sig.slPct, CONFIG.maxTradeSizeUSD) / sig.entry;

      const pos = {
        symbol,
        side:       sig.side,
        entryPrice: sig.entry,
        initialSL:  sig.sl,
        currentSL:  sig.sl,
        tp:         sig.tp,
        quantity,
        entryTime:  now,
      };

      if (CONFIG.paperTrading) {
        pos.orderId = `DMC-PAPER-${Date.now()}`;
        pos.algoId  = null;
        log(`[DMC][PAPER] 開倉 ${symbol}(${sig.side}) | 進場 $${sig.entry.toFixed(4)} | SL $${sig.sl.toFixed(4)} | TP $${sig.tp.toFixed(4)}`);
      } else {
        const { orderId, algoId } = await placeEntry(symbol, sig, portfolioValue);
        pos.orderId = orderId;
        pos.algoId  = algoId;
        log(`[DMC][LIVE] 開倉 ${symbol}(${sig.side}) orderId=${orderId}`);
      }

      appendCsv(pos, null, null, "開倉");
      positions.open.push(pos);

    } catch(e) { log(`⚠️ ${symbol} 處理失敗: ${e.message}`); }

    await new Promise(r=>setTimeout(r,200));
  }

  savePositions(positions);
  log(`[DMC] 完成 | 開倉數: ${positions.open.length}`);
}

run().catch(e=>console.error("[DMC] 致命錯誤:", e.message));
