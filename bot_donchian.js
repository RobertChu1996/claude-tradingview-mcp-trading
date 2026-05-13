/**
 * Strategy DN: Donchian Breakout (日線)
 * 牛市（BTC > MA200）：日線收盤突破 N30 最高 → 做多，SL = N15日最低（上移）
 * 熊市（BTC < MA200）：日線收盤突破 N30 最低 → 做空，SL = N15日最高（下移）
 * 止盈：3.0:1 R:R | 回測（3年43幣雙向）：PF 2.05，+85%，最大回撤 10.9%
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import {
  POSITIONS_DN_FILE as POSITIONS_FILE,
  LOG_DN_FILE       as LOG_FILE,
  CSV_DN_FILE       as CSV_FILE,
} from "./paths.js";

// ─── 策略參數 ─────────────────────────────────────────────────────────────────
const N_HIGH      = 30;    // 突破：前N根最高
const N_LOW       = 15;    // 止損：前N根最低
const TP_RATIO    = 3.0;   // 止盈比
const BTC_MA_BARS = 200;   // BTC 趨勢過濾
const COOLDOWN_MS = 3 * 24 * 3600 * 1000; // 3天冷卻

const CONFIG = {
  paperTrading:    process.env.DONCHIAN_PAPER_TRADING !== "false",
  portfolioValue:  parseFloat(process.env.PORTFOLIO_VALUE_USD  || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD   || "200"),
  riskPct:         parseFloat(process.env.RISK_PCT             || "0.01"),
  maxOpen:         parseInt  (process.env.DONCHIAN_MAX_OPEN    || "8"),
  okx: {
    apiKey:     process.env.OKX_API_KEY,
    secretKey:  process.env.OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE,
    baseUrl:    process.env.OKX_BASE_URL || "https://www.okx.com",
  },
};

// ─── 幣種清單（59幣，對應回測）────────────────────────────────────────────────
const SYMBOLS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","AVAXUSDT","DOGEUSDT","DOTUSDT","LINKUSDT",
  "LTCUSDT","NEARUSDT","UNIUSDT","AAVEUSDT","ATOMUSDT",
  "FILUSDT","ETCUSDT","XLMUSDT","ALGOUSDT",
  "CRVUSDT","INJUSDT","APTUSDT","ARBUSDT","OPUSDT",
  "LDOUSDT","RUNEUSDT","SEIUSDT","SUIUSDT","TIAUSDT",
  "STXUSDT","ORDIUSDT","WLDUSDT","BLURUSDT","PENDLEUSDT",
  "FETUSDT","RENDERUSDT","JUPUSDT","ENAUSDT","EIGENUSDT",
  "BCHUSDT","TRXUSDT","ICPUSDT","HBARUSDT","VETUSDT",
  "SANDUSDT","MANAUSDT","AXSUSDT","GALAUSDT",
  "DYDXUSDT","ENSUSDT","GMXUSDT","SNXUSDT","YFIUSDT",
  "COMPUSDT","SUSHIUSDT","1INCHUSDT","ZECUSDT",
];

const CSV_HEADERS = "Date,Time(UTC),Symbol,Side,Entry,Exit,PnL,Reason,Mode,OrderID";

// ─── 工具函式 ─────────────────────────────────────────────────────────────────
function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return { open: [], closed: [], cooldown: {} };
  try { return JSON.parse(readFileSync(POSITIONS_FILE, "utf8")); }
  catch { return { open: [], closed: [], cooldown: {} }; }
}
function savePositions(p) {
  // 只保留最近90天已平倉
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
    `${d.slice(0,10)},${d.slice(11,19)},${pos.symbol},${pos.side ?? "long"},` +
    `${pos.entryPrice},${exitPrice?.toFixed(6) ?? ""},${pnl?.toFixed(2) ?? ""},` +
    `${reason},${CONFIG.paperTrading ? "PAPER" : "LIVE"},${pos.orderId}\n`,
    { flag: "a" }
  );
}

// ─── 市場資料（Binance 日線）──────────────────────────────────────────────────
async function fetchDailyCandles(symbol, limit = 260) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  return (await res.json()).map(k => ({
    time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
  }));
}

// 只取已完成的日線（排除今天開盤中的蠟燭）
function completedCandles(candles) {
  const todayOpen = new Date().setUTCHours(0, 0, 0, 0);
  return candles.filter(c => c.time < todayOpen);
}

// ─── 指標計算 ─────────────────────────────────────────────────────────────────
function rollingHigh(candles, n) {
  return Math.max(...candles.slice(-n).map(c => c.high));
}
function rollingLow(candles, n) {
  return Math.min(...candles.slice(-n).map(c => c.low));
}
function sma(closes, n) {
  const sl = closes.slice(-n);
  return sl.reduce((a, b) => a + b, 0) / sl.length;
}

// ─── BTC 趨勢過濾 ─────────────────────────────────────────────────────────────
async function isBtcBull() {
  try {
    const c = completedCandles(await fetchDailyCandles("BTCUSDT", BTC_MA_BARS + 5));
    if (c.length < BTC_MA_BARS) return true; // 不足時放行
    const ma = sma(c.map(x => x.close), BTC_MA_BARS);
    return c[c.length - 1].close >= ma;
  } catch { return true; }
}

// ─── 進場信號 ─────────────────────────────────────────────────────────────────
async function checkLongSignal(symbol) {
  const raw = await fetchDailyCandles(symbol, N_HIGH + N_LOW + 10);
  const c   = completedCandles(raw);
  if (c.length < N_HIGH + N_LOW) return null;

  const last     = c[c.length - 1];
  const prev     = c.slice(0, -1);
  const prevHigh = rollingHigh(prev.slice(-N_HIGH), N_HIGH);
  const curLow   = rollingLow(c.slice(-N_LOW), N_LOW);

  if (last.close <= prevHigh) return null;

  const entry = last.close;
  const sl    = curLow;
  const slPct = (entry - sl) / entry;

  if (sl >= entry) return null;
  if (slPct < 0.003 || slPct > 0.25) return null;

  const tp = entry + (entry - sl) * TP_RATIO;
  return { side: "long", entry, sl, tp, slPct, level: prevHigh, candle: last };
}

async function checkShortSignal(symbol) {
  const raw = await fetchDailyCandles(symbol, N_HIGH + N_LOW + 10);
  const c   = completedCandles(raw);
  if (c.length < N_HIGH + N_LOW) return null;

  const last    = c[c.length - 1];
  const prev    = c.slice(0, -1);
  const prevLow = rollingLow(prev.slice(-N_HIGH), N_HIGH);
  const curHigh = rollingHigh(c.slice(-N_LOW), N_LOW);

  // 突破：昨日收盤 < 前N日最低
  if (last.close >= prevLow) return null;

  const entry = last.close;
  const sl    = curHigh;
  const slPct = (sl - entry) / entry;

  if (sl <= entry) return null;
  if (slPct < 0.003 || slPct > 0.25) return null;

  const tp = entry - (sl - entry) * TP_RATIO;
  if (tp <= 0) return null;
  return { side: "short", entry, sl, tp, slPct, level: prevLow, candle: last };
}

// ─── 追蹤止損更新 ─────────────────────────────────────────────────────────────
async function calcNewLongSL(symbol, currentSL) {
  try {
    const raw = await fetchDailyCandles(symbol, N_LOW + 5);
    const c   = completedCandles(raw);
    if (c.length < N_LOW) return currentSL;
    const newSL = rollingLow(c.slice(-N_LOW), N_LOW);
    return newSL > currentSL ? newSL : currentSL; // 只能上移
  } catch { return currentSL; }
}

async function calcNewShortSL(symbol, currentSL) {
  try {
    const raw = await fetchDailyCandles(symbol, N_LOW + 5);
    const c   = completedCandles(raw);
    if (c.length < N_LOW) return currentSL;
    const newSL = rollingHigh(c.slice(-N_LOW), N_LOW);
    return newSL < currentSL ? newSL : currentSL; // 只能下移
  } catch { return currentSL; }
}

// ─── OKX API ──────────────────────────────────────────────────────────────────
function sign(ts, method, path, body = "") {
  return crypto.createHmac("sha256", CONFIG.okx.secretKey)
    .update(`${ts}${method}${path}${body}`).digest("base64");
}
async function okxPost(path, bodyObj) {
  const ts   = new Date().toISOString();
  const body = JSON.stringify(bodyObj);
  const res  = await fetch(`${CONFIG.okx.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY":        CONFIG.okx.apiKey,
      "OK-ACCESS-SIGN":       sign(ts, "POST", path, body),
      "OK-ACCESS-TIMESTAMP":  ts,
      "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase,
    },
    body,
  });
  return res.json();
}
async function okxGet(path) {
  const ts  = new Date().toISOString();
  const res = await fetch(`${CONFIG.okx.baseUrl}${path}`, {
    headers: {
      "OK-ACCESS-KEY":        CONFIG.okx.apiKey,
      "OK-ACCESS-SIGN":       sign(ts, "GET", path),
      "OK-ACCESS-TIMESTAMP":  ts,
      "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase,
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
  const spec = { ctVal: +inst.ctVal, minSz: +inst.minSz, lotSz: +inst.lotSz };
  _specCache[instId] = spec;
  return spec;
}
function floorLot(v, lotSz) {
  const f = Math.pow(10, Math.round(-Math.log10(lotSz)));
  return Math.floor(v * f) / f;
}

// ─── 下單：市場進場 + OCO（SL + TP）─────────────────────────────────────────
async function placeEntry(symbol, sig) {
  const instId  = symbol.replace("USDT", "-USDT-SWAP");
  const spec    = await fetchSpec(instId);
  const riskUSD = CONFIG.portfolioValue * CONFIG.riskPct;
  const rawSz   = riskUSD / sig.slPct / sig.entry / spec.ctVal;
  const sz      = String(floorLot(Math.min(rawSz, CONFIG.maxTradeSizeUSD / sig.entry / spec.ctVal), spec.lotSz));

  if (+sz < spec.minSz) throw new Error(`倉位太小 ${sz} < ${spec.minSz}`);

  const isShort   = sig.side === "short";
  const entrySide = isShort ? "sell" : "buy";
  const exitSide  = isShort ? "buy"  : "sell";
  const posSide   = isShort ? "short" : "long";

  // 1. 市場進場
  const entryRes = await okxPost("/api/v5/trade/order", {
    instId, tdMode: "isolated", side: entrySide, posSide,
    ordType: "market", sz,
  });
  if (entryRes.code !== "0") throw new Error(`進場失敗: ${entryRes.msg}`);
  const orderId = entryRes.data?.[0]?.ordId;

  // 2. OCO（止損 + 止盈）
  const ocoRes = await okxPost("/api/v5/trade/order-algo", {
    instId, tdMode: "isolated", side: exitSide, posSide,
    ordType: "oco", sz,
    slTriggerPx: sig.sl.toFixed(8), slOrdPx: "-1", slTriggerPxType: "last",
    tpTriggerPx: sig.tp.toFixed(8), tpOrdPx: "-1", tpTriggerPxType: "last",
  });
  if (ocoRes.code !== "0") throw new Error(`OCO失敗: ${ocoRes.msg}`);
  const algoId = ocoRes.data?.[0]?.algoId;

  return { orderId, algoId, sz: +sz * spec.ctVal * sig.entry };
}

// 更新追蹤止損：取消舊 OCO → 重掛新 OCO
async function updateOCO(pos, newSL) {
  const instId  = pos.symbol.replace("USDT", "-USDT-SWAP");
  const spec    = await fetchSpec(instId);
  const sz      = String(floorLot(pos.quantity / spec.ctVal, spec.lotSz));
  const tp      = pos.tp;
  const isShort = pos.side === "short";
  const posSide = isShort ? "short" : "long";
  const exitSide = isShort ? "buy" : "sell";

  const cancel = await okxPost("/api/v5/trade/cancel-algos", [{ algoId: pos.algoId, instId }]);
  if (cancel.code !== "0") log(`⚠️  取消舊OCO失敗 ${pos.symbol}: ${cancel.msg}`);

  const ocoRes = await okxPost("/api/v5/trade/order-algo", {
    instId, tdMode: "isolated", side: exitSide, posSide,
    ordType: "oco", sz,
    slTriggerPx: newSL.toFixed(8), slOrdPx: "-1", slTriggerPxType: "last",
    tpTriggerPx: tp.toFixed(8),   tpOrdPx: "-1", tpTriggerPxType: "last",
  });
  if (ocoRes.code !== "0") throw new Error(`新OCO失敗: ${ocoRes.msg}`);
  return ocoRes.data?.[0]?.algoId;
}

// 檢查 OCO 狀態
async function checkAlgoStatus(algoId, instId) {
  const res = await okxGet(`/api/v5/trade/order-algo?ordType=oco&algoId=${algoId}&instId=${instId}`);
  return res.data?.[0]?.state; // "live" | "effective" | "filled" | "cancelled" | "stopped"
}

// ─── Paper Trading 出場模擬 ───────────────────────────────────────────────────
async function checkPaperExit(pos) {
  try {
    const raw = await fetchDailyCandles(pos.symbol, 3);
    const c   = completedCandles(raw);
    if (!c.length) return null;
    const last = c[c.length - 1];
    if (pos.side === "short") {
      if (last.high >= pos.currentSL) return { reason: "止損", price: pos.currentSL };
      if (last.low  <= pos.tp)        return { reason: "止盈", price: pos.tp };
    } else {
      if (last.low  <= pos.currentSL) return { reason: "止損", price: pos.currentSL };
      if (last.high >= pos.tp)        return { reason: "止盈", price: pos.tp };
    }
    return null;
  } catch { return null; }
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────
async function run() {
  initCsv();
  const positions = loadPositions();
  if (!positions.cooldown) positions.cooldown = {};

  const now       = Date.now();
  const utcHour   = new Date(now).getUTCHours();
  const utcMin    = new Date(now).getUTCMinutes();
  const isDailyWin = utcHour === 0 && utcMin < 15; // 每日 UTC 00:00-00:14

  const longOpen  = positions.open.filter(p => p.side !== "short").length;
  const shortOpen = positions.open.filter(p => p.side === "short").length;
  log(`[DN] 開始 | 模式:${CONFIG.paperTrading?"PAPER":"LIVE"} | 開倉:${positions.open.length}/${CONFIG.maxOpen}(多${longOpen}/空${shortOpen}) | 日線窗口:${isDailyWin}`);

  // Paper→Live 防衛
  if (!CONFIG.paperTrading) {
    const paperOpen = positions.open.filter(p => p.orderId?.startsWith("DONCHIAN-PAPER-"));
    if (paperOpen.length > 0) {
      log(`⚠️ 偵測到 PAPER→LIVE 切換，清除 ${paperOpen.length} 筆模擬倉位，本輪跳過`);
      positions.open = positions.open.filter(p => !p.orderId?.startsWith("DONCHIAN-PAPER-"));
      savePositions(positions);
      return;
    }
  }

  // ── Step 1：檢查已關閉的倉位 ─────────────────────────────────────────────
  for (const pos of [...positions.open]) {
    if (CONFIG.paperTrading) {
      // Paper：模擬出場
      const exit = await checkPaperExit(pos);
      if (exit) {
        const sign = pos.side === "short" ? -1 : 1;
        const pnl  = sign * (exit.price - pos.entryPrice) * pos.quantity;
        log(`[DN][PAPER] 出場 ${pos.symbol}(${pos.side}) ${exit.reason} $${exit.price.toFixed(4)} PnL $${pnl.toFixed(2)}`);
        appendCsv(pos, exit.price, pnl, exit.reason);
        positions.closed.push({ ...pos, exitTime: now, exitPrice: exit.price, pnl });
        positions.cooldown[pos.symbol] = now;
        positions.open = positions.open.filter(p => p !== pos);
      }
    } else {
      // Live：查詢 OKX OCO 狀態
      try {
        const instId = pos.symbol.replace("USDT", "-USDT-SWAP");
        const state  = await checkAlgoStatus(pos.algoId, instId);
        if (state === "filled" || state === "cancelled" || state === "stopped") {
          log(`[DN] 出場確認 ${pos.symbol} (algoId ${pos.algoId}) state=${state}`);
          appendCsv(pos, null, null, state);
          positions.closed.push({ ...pos, exitTime: now, exitState: state });
          positions.cooldown[pos.symbol] = now;
          positions.open = positions.open.filter(p => p !== pos);
        }
      } catch(e) { log(`⚠️ 查詢OCO失敗 ${pos.symbol}: ${e.message}`); }
    }
  }

  // ── Step 2：每日窗口 ─────────────────────────────────────────────────────
  if (!isDailyWin) {
    savePositions(positions);
    log(`[DN] 非日線窗口，跳過信號掃描`);
    return;
  }

  // Step 2a：更新追蹤止損
  for (const pos of positions.open) {
    try {
      const isShort = pos.side === "short";
      const newSL   = isShort
        ? await calcNewShortSL(pos.symbol, pos.currentSL)
        : await calcNewLongSL(pos.symbol, pos.currentSL);
      const moved = isShort ? newSL < pos.currentSL : newSL > pos.currentSL;
      if (moved) {
        log(`[DN] 追蹤止損移動 ${pos.symbol}(${pos.side}): $${pos.currentSL.toFixed(6)} → $${newSL.toFixed(6)}`);
        if (CONFIG.paperTrading) {
          pos.currentSL = newSL;
        } else {
          const newAlgoId = await updateOCO(pos, newSL);
          pos.currentSL = newSL;
          pos.algoId    = newAlgoId;
          log(`[DN] 新OCO algoId: ${newAlgoId}`);
        }
      }
    } catch(e) { log(`⚠️ 更新止損失敗 ${pos.symbol}: ${e.message}`); }
  }

  // Step 2b：掃描新信號
  if (positions.open.length >= CONFIG.maxOpen) {
    log(`[DN] 已滿倉 (${positions.open.length}/${CONFIG.maxOpen})，跳過掃描`);
    savePositions(positions);
    return;
  }

  // BTC 趨勢判斷
  const bull = await isBtcBull();
  const direction = bull ? "long" : "short";
  log(`[DN] BTC ${bull ? "牛市→做多" : "熊市→做空"}，掃描 ${SYMBOLS.length} 幣種...`);

  for (const symbol of SYMBOLS) {
    if (positions.open.length >= CONFIG.maxOpen) break;
    if (positions.open.some(p => p.symbol === symbol)) continue;

    const lastExit = positions.cooldown[symbol];
    if (lastExit && now - lastExit < COOLDOWN_MS) continue;

    try {
      const sig = bull ? await checkLongSignal(symbol) : await checkShortSignal(symbol);
      if (!sig) continue;

      log(`[DN] 信號 ${symbol}(${sig.side}) | 突破 $${sig.level.toFixed(4)} | SL $${sig.sl.toFixed(4)} | TP $${sig.tp.toFixed(4)} | 止損% ${(sig.slPct*100).toFixed(2)}%`);

      const riskUSD  = CONFIG.portfolioValue * CONFIG.riskPct;
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
        pos.orderId = `DONCHIAN-PAPER-${Date.now()}`;
        pos.algoId  = null;
        log(`[DN][PAPER] 開倉 ${symbol}(${sig.side}) | 進場 $${sig.entry.toFixed(4)} | SL $${sig.sl.toFixed(4)} | TP $${sig.tp.toFixed(4)}`);
      } else {
        const { orderId, algoId, sz } = await placeEntry(symbol, sig);
        pos.orderId   = orderId;
        pos.algoId    = algoId;
        pos.sizeUSD   = sz;
        log(`[DN][LIVE] 開倉 ${symbol}(${sig.side}) | orderId ${orderId} | algoId ${algoId}`);
      }

      appendCsv(pos, null, null, "開倉");
      positions.open.push(pos);

    } catch(e) {
      log(`⚠️ ${symbol} 處理失敗: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  savePositions(positions);
  log(`[DN] 完成 | 開倉數: ${positions.open.length}`);
}

run().catch(e => console.error("[DN] 致命錯誤:", e.message));
