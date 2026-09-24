/**
 * 策略 B (DMC) — Portfolio 回測，支援 MAX_OPEN 比較
 * 按時間順序跨幣種處理，全局共享倉位上限（與 GHA bot 一致）
 *
 * node backtest_dmc.js [max_open]        → 單一上限測試（預設6）
 * node backtest_dmc.js compare           → 4 vs 6 比較
 * node backtest_dmc.js 6 30              → MAX_OPEN=6，前30幣
 * node backtest_dmc.js filter            → 三路比較：基準 vs BTC過濾 vs BTC過濾+同向上限
 */

// ─── 參數（與 bot_dmc.js 完全一致）──────────────────────────────────────────
const SMA_PERIOD      = 25;
const VOL_RATIO       = 1.5;
const STRENGTH        = 0.7;
const SWING_LB        = 8;
const ATR_MULT        = 0.05;
const TP_RATIO        = 3.0;
const SMA_PREV_OFFSET = 5;
const COOLDOWN_BARS   = 2;   // 止損/止盈後冷卻 2 根4H棒
const MIN_PRICE       = 0.001;

const COMPARE_MODE  = process.argv[2] === "compare";
const FILTER_MODE   = process.argv[2] === "filter";
const OPTIMIZE_MODE = process.argv[2] === "optimize";
const LONGFIX_MODE  = process.argv[2] === "longfix";   // 多單 regime 濾網驗證（含樣本內外拆分）
const MAX_OPEN      = LONGFIX_MODE ? 4 : (COMPARE_MODE || FILTER_MODE || OPTIMIZE_MODE) ? 6 : parseInt(process.argv[2] || "6");
const SYMBOL_LIMIT  = parseInt(process.argv[3] || "30");
const MONTHS        = parseInt(process.argv[4] || "12");
const PORTFOLIO     = 1000;
const RISK_PCT      = parseFloat(process.env.BT_RISK_PCT || "0.01");       // 可由環境變數覆寫做風險%取捨研究
const MAX_TRADE_USD = parseFloat(process.env.BT_MAX_TRADE_USD || "200");   // 隨風險%等比放大以看純效果
const FEE_RATE      = 0.0005;  // OKX taker 0.05%/邊；round-trip = 進場+出場各扣一次
// 每筆平倉的手續費：進場名目 + 出場名目，各乘費率。分批止盈只算被平掉的那部分。
const feeFor = (qty, entryPx, exitPx) => FEE_RATE * (qty * entryPx + qty * exitPx);
const LOOKBACK      = SMA_PERIOD + SMA_PREV_OFFSET + 10;
const INTERVAL      = process.env.BT_INTERVAL || "4h";   // 可調時間週期：15m / 30m / 1h / 4h
const _MS = { "15m": 15*60*1000, "30m": 30*60*1000, "1h": 3600*1000, "4h": 4*3600*1000 };
const MS_CANDLE     = _MS[INTERVAL] || 4 * 3600 * 1000;

// ─── 幣種清單（與 bot_dmc.js 靜態清單一致）──────────────────────────────────
const WATCHLIST = [
  "BTCUSDT",
  "EIGENUSDT",
  "CELOUSDT",
  "MORPHOUSDT",
  "LDOUSDT",
  "SUIUSDT",
  "BLURUSDT",
  "CROUSDT",
  "STRKUSDT",
  "LITUSDT",
  "SNXUSDT",
  "ETHUSDT",
  "DOGEUSDT",
  "TRBUSDT",
  "AAVEUSDT",
  "PNUTUSDT",
  "DOODUSDT",
  "IOTAUSDT",
  "ZROUSDT",
  "DYDXUSDT",
  "CHZUSDT",
  "OLUSDT",
  "RVNUSDT",
  "ZKUSDT",
  "ZENUSDT",
  "CRVUSDT",
  "INJUSDT",
  "KAITOUSDT",
  "BCHUSDT",
  "RESOLVUSDT",
  "API3USDT",
  "ENSUSDT",
  "KITEUSDT",
  "OPUSDT",
  "JUPUSDT",
  "ARBUSDT",
  "GALAUSDT",
  "TRXUSDT",
  "AGLDUSDT",
  "ETCUSDT",
  "EGLDUSDT",
  "BERAUSDT",
  "COREUSDT",
  "AUSDT",
  "TRUMPUSDT",
  "WIFUSDT",
  "SOLUSDT",
  "BABYUSDT",
  "CFXUSDT",
  "ENAUSDT",
  "PIUSDT",
  "2ZUSDT",
  "KATUSDT",
].slice(0, SYMBOL_LIMIT);

// ─── Binance 4H 歷史資料 ──────────────────────────────────────────────────────
async function fetchCandles(symbol) {
  const fetch   = (await import("node-fetch")).default;
  const need    = Math.ceil((MONTHS * 30 * 24 * 3600 * 1000) / MS_CANDLE) + LOOKBACK + 10;
  const all     = [];
  let endTime   = Date.now();

  while (all.length < need) {
    const limit = Math.min(1000, need - all.length);
    const url   = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&endTime=${endTime}&limit=${limit}`;
    const res   = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data  = await res.json();
    if (!data.length) break;
    const candles = data.map(k => ({
      time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
    all.unshift(...candles);
    endTime = data[0][0] - 1;
    if (data.length < limit) break;
  }
  return all.sort((a, b) => a.time - b.time);
}

// ─── 指標（與 bot_dmc.js 一致）───────────────────────────────────────────────
function smaOf(closes, n) {
  return closes.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function atrOf(candles, n = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const p = candles[i].close;
    return Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p));
  });
  return trs.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function avgVolOf(candles, n = 20) {
  return candles.slice(-n).reduce((s, c) => s + c.volume, 0) / n;
}
function swingLowOf(candles, lb) {
  return Math.min(...candles.slice(-lb - 1, -1).map(c => c.low));
}
function swingHighOf(candles, lb) {
  return Math.max(...candles.slice(-lb - 1, -1).map(c => c.high));
}
// EMA of closes (最後一根的值)
function emaOf(closes, n) {
  if (closes.length < n) return null;
  const k = 2 / (n + 1);
  let ema = closes.slice(0, n).reduce((a, b) => a + b, 0) / n;  // 以前 n 根 SMA 起頭
  for (let i = n; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}
// Wilder ADX（回傳最後一根的 ADX；資料不足回 null）—— 趨勢強度，用來擋震盪盤
function adxOf(candles, n = 14) {
  if (candles.length < n * 2 + 1) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    const ph = candles[i - 1].high, pl = candles[i - 1].low;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, down = pl - l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  // Wilder 平滑
  const wilder = (arr) => {
    let s = arr.slice(0, n).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = n; i < arr.length; i++) { s = s - s / n + arr[i]; out.push(s); }
    return out;
  };
  const trS = wilder(tr), pdS = wilder(plusDM), mdS = wilder(minusDM);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    const pDI = 100 * pdS[i] / (trS[i] || 1e-9);
    const mDI = 100 * mdS[i] / (trS[i] || 1e-9);
    const sum = pDI + mDI;
    dx.push(sum ? 100 * Math.abs(pDI - mDI) / sum : 0);
  }
  if (dx.length < n) return null;
  // ADX = DX 的 Wilder 平均
  let adx = dx.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < dx.length; i++) adx = (adx * (n - 1) + dx[i]) / n;
  return adx;
}

// ─── 進場信號（volRatio 可調 + 波動率自適應門檻）─────────────────────────────
// adapt: { kVol, kStr } —— 借 GainzAlgo 概念，門檻 = 固定值 × (1 + (atr/price)*k)
//   高波動 → 門檻拉高（要求更強確認）；低波動 → 放寬。null/0 = 沿用固定門檻。
function checkSignal(candles, volRatio = VOL_RATIO, adapt = null) {
  if (candles.length < SMA_PERIOD + SMA_PREV_OFFSET + 10) return null;
  const closes   = candles.map(c => c.close);
  const price    = closes[closes.length - 1];
  if (price < MIN_PRICE) return null;

  const smaNow  = smaOf(closes, SMA_PERIOD);
  const smaPrev = smaOf(closes.slice(0, -SMA_PREV_OFFSET), SMA_PERIOD);
  const last    = candles[candles.length - 1];
  const volR    = last.volume / avgVolOf(candles, 20);
  const body    = Math.abs(last.close - last.open);
  const range   = last.high - last.low || 0.0001;
  const strength = body / range;
  const rec3    = closes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const prev3   = closes.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
  const atr     = atrOf(candles, 14);

  // 波動率自適應門檻
  const atrPct  = atr / price;
  const kVol    = adapt?.kVol ?? 0;
  const kStr    = adapt?.kStr ?? 0;
  const volThr  = volRatio * (1 + atrPct * kVol);
  const strThr  = Math.min(0.95, STRENGTH * (1 + atrPct * kStr));   // 強度上限 0.95（body/range≤1）

  if (smaNow > smaPrev && price > smaNow && volR > volThr &&
      last.close > last.open && strength > strThr && rec3 > prev3) {
    const sl    = swingLowOf(candles, SWING_LB) - atr * ATR_MULT;
    const slPct = (price - sl) / price;
    if (sl >= price || slPct < 0.003 || slPct > 0.15) return null;
    const tp = price + (price - sl) * TP_RATIO;
    return { side: "long", stopLoss: sl, tp };
  }
  if (smaNow < smaPrev && price < smaNow && volR > volThr &&
      last.close < last.open && strength > strThr && rec3 < prev3) {
    const sl    = swingHighOf(candles, SWING_LB) + atr * ATR_MULT;
    const slPct = (sl - price) / price;
    if (sl <= price || slPct < 0.003 || slPct > 0.15) return null;
    const tp = price - (sl - price) * TP_RATIO;
    if (tp <= 0) return null;
    return { side: "short", stopLoss: sl, tp };
  }
  return null;
}

// ─── 1D SMA 方向（多時框確認，band 可調）────────────────────────────────────
function dailyTrend(dailyCandles, ts, band = 0.001) {
  const idx = dailyCandles.findLastIndex(c => c.time <= ts);
  if (idx < SMA_PERIOD + SMA_PREV_OFFSET) return 0;
  const closes  = dailyCandles.slice(0, idx + 1).map(c => c.close);
  const smaNow  = smaOf(closes, SMA_PERIOD);
  const smaPrev = smaOf(closes.slice(0, -SMA_PREV_OFFSET), SMA_PERIOD);
  if (smaNow > smaPrev * (1 + band)) return  1;
  if (smaNow < smaPrev * (1 - band)) return -1;
  return 0;
}

// ─── 追蹤止損（trailStart = 開始移動的 R 倍數門檻）──────────────────────────
function trailingSL(pos, price, trailStart = 1.0, fixTrail = false) {
  // fixTrail=true: 用 initialSL 計算 R，避免 trendTightenSL 把 risk 壓成 0
  const risk = fixTrail
    ? Math.abs(pos.entryPrice - (pos.initialSL ?? pos.stopLoss))
    : Math.abs(pos.entryPrice - pos.stopLoss);
  if (!risk) return pos.stopLoss;
  const profit  = pos.side === "long" ? price - pos.entryPrice : pos.entryPrice - price;
  const profitR = profit / risk;
  if (profitR < trailStart) return pos.stopLoss;
  const lockR = Math.max(0, Math.floor(profitR * 2) / 2 - trailStart);
  const ns    = pos.side === "long"
    ? pos.entryPrice + risk * lockR
    : pos.entryPrice - risk * lockR;
  return pos.side === "long" ? Math.max(pos.stopLoss, ns) : Math.min(pos.stopLoss, ns);
}

// ─── 出場判斷（用 high/low 觸發，更準確）────────────────────────────────────
function checkExit(pos, candle, trailStart = 1.0, fixTrail = false) {
  const sl = trailingSL(pos, candle.close, trailStart, fixTrail);
  pos.stopLoss = sl;

  if (pos.side === "long") {
    const slHit = candle.low  <= sl;
    const tpHit = candle.high >= pos.tp;
    if (slHit && tpHit) {
      const tpFirst = candle.close > candle.open;
      return { exit: true, ep: tpFirst ? pos.tp : sl, reason: tpFirst ? "止盈" : "止損" };
    }
    if (tpHit) return { exit: true, ep: pos.tp,  reason: "止盈" };
    if (slHit) return { exit: true, ep: sl,       reason: "止損" };
  } else {
    const slHit = candle.high >= sl;
    const tpHit = candle.low  <= pos.tp;
    if (slHit && tpHit) {
      const tpFirst = candle.close < candle.open;
      return { exit: true, ep: tpFirst ? pos.tp : sl, reason: tpFirst ? "止盈" : "止損" };
    }
    if (tpHit) return { exit: true, ep: pos.tp,  reason: "止盈" };
    if (slHit) return { exit: true, ep: sl,       reason: "止損" };
  }
  return { exit: false };
}

// ─── 月報輸出 ─────────────────────────────────────────────────────────────────
function printReport(label, trades, maxOpen) {
  const byMonth = {};
  for (const t of trades) {
    const m = new Date(t.exitTime).toISOString().slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { trades: 0, wins: 0, pnl: 0 };
    byMonth[m].trades++;
    byMonth[m].pnl += t.pnl;
    if (t.win) byMonth[m].wins++;
  }

  console.log(`\n${"═".repeat(62)}`);
  console.log(`  策略 B (DMC) — MAX_OPEN=${maxOpen} — ${trades.length} 筆平倉`);
  console.log(`${"═".repeat(62)}`);
  console.log(`  月份      筆數   勝率     月損益    累積損益`);
  console.log(`  ${"─".repeat(55)}`);

  let cum = 0;
  for (const m of Object.keys(byMonth).sort()) {
    const d  = byMonth[m];
    const wr = d.trades ? ((d.wins / d.trades) * 100).toFixed(0) : "0";
    cum += d.pnl;
    console.log(`  ${m}   ${String(d.trades).padStart(4)}  ${wr.padStart(4)}%  ${((d.pnl >= 0 ? "+" : "") + d.pnl.toFixed(2)).padStart(9)}  ${((cum >= 0 ? "+" : "") + cum.toFixed(2)).padStart(10)}`);
  }

  const wins    = trades.filter(t => t.win);
  const losses  = trades.filter(t => !t.win);
  const wr      = trades.length ? (wins.length / trades.length * 100).toFixed(1) : "0";
  const allPnl  = trades.reduce((s, t) => s + t.pnl, 0);
  const sumWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const sumLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf      = sumLoss > 0 ? (sumWin / sumLoss).toFixed(2) : "∞";
  const avgW    = wins.length   ? (sumWin / wins.length).toFixed(2)     : "0";
  const avgL    = losses.length ? (sumLoss / losses.length).toFixed(2)  : "0";
  const mdd     = calcMDD(trades);

  console.log(`  ${"─".repeat(55)}`);
  console.log(`  全期合計  ${String(trades.length).padStart(4)}  ${wr.padStart(4)}%  ${((allPnl >= 0 ? "+" : "") + allPnl.toFixed(2)).padStart(9)}`);
  console.log(`\n  平均獲利: +$${avgW} | 平均虧損: -$${avgL}`);
  console.log(`  Profit Factor: ${pf} | MDD: ${mdd.toFixed(1)}%`);
}

function calcMDD(trades) {
  let peak = 0, mdd = 0, cum = 0;
  for (const t of trades.sort((a, b) => a.exitTime - b.exitTime)) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    const dd = peak > 0 ? (peak - cum) / PORTFOLIO * 100 : 0;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

// ─── BTC 趨勢方向（給定時間點的 SMA25 方向）────────────────────────────────
// method: "sma_slope"（SMA斜率，預設）| "price_vs_sma"（價格 vs SMA）
function btcTrend(btcCandles, ts, opts = {}) {
  const { band = 0.001, prevOffset = SMA_PREV_OFFSET, method = "sma_slope" } = opts;
  const idx = btcCandles.findIndex(c => c.time === ts);
  if (idx < SMA_PERIOD + prevOffset) return 0;
  const closes = btcCandles.slice(0, idx + 1).map(c => c.close);
  const smaNow = smaOf(closes, SMA_PERIOD);

  if (method === "price_vs_sma") {
    const price = closes[closes.length - 1];
    if (price > smaNow * (1 + band)) return  1;
    if (price < smaNow * (1 - band)) return -1;
    return 0;
  }

  // sma_slope（預設）
  const smaPrev = smaOf(closes.slice(0, -prevOffset), SMA_PERIOD);
  if (smaNow > smaPrev * (1 + band)) return  1;
  if (smaNow < smaPrev * (1 - band)) return -1;
  return 0;
}

// ─── 核心模擬 ─────────────────────────────────────────────────────────────────
// opts: { btcFilter, maxSameDir, volRatio, timeFilter, partialTP, timeSL, timeSLBars,
//         fundingProxy, dailyData, mtfBand, trailStart,
//         atrFilter, tpRatio, lossStreakReduce, strictSidewaysShort }
function runSimulation(allData, times, cutoff, maxOpen, opts = {}) {
  const {
    btcFilter           = false,
    btcBand             = 0.001,
    btcPrevOffset       = SMA_PREV_OFFSET,
    btcMethod           = "sma_slope",
    trendExit           = false,  // A: 趨勢翻轉時平掉反向持倉
    trendTightenSL      = false,  // B: 趨勢翻轉時將反向持倉 SL 移到保本
    fixTrailAfterBreakeven = false, // 修正：保本後仍用 initialSL 計算追蹤止損 R 值
    maxSameDir          = maxOpen,
    maxLong             = maxOpen,  // 只限多頭同時持倉數
    longMaxSlPct        = 0.15,     // 多頭 SL 距離上限（過濾寬 SL 高波動幣）
    longVolRatio        = null,     // 多頭專屬量能門檻（null = 與空頭相同）
    longStrength        = null,     // 多頭專屬蠟燭強度門檻（null = 與空頭相同）
    shortMaxSlPct       = 0.15,     // 空頭 SL 距離上限
    shortVolRatio       = null,     // 空頭專屬量能門檻
    shortStrength       = null,     // 空頭專屬蠟燭強度門檻
    volRatio            = VOL_RATIO,
    adapt               = null,   // 波動率自適應門檻 { kVol, kStr }
    timeFilter          = false,
    partialTP           = false,
    timeSL              = false,
    timeSLBars          = 10,
    fundingProxy        = false,
    dailyData           = null,
    mtfBand             = 0.001,
    trailStart          = 1.0,
    atrFilter           = false,
    tpRatio             = TP_RATIO,
    lossStreakReduce    = false,
    strictSidewaysShort = false,
    // ── 多單專屬「趨勢/regime」濾網（診斷發現多單=13%勝率的止血目標）──
    longRequireDailyUp  = false,  // 個幣 1D 必須「明確上升」(dailyTrend===1)，不只是「非下跌」
    longAdxMin          = 0,      // 多單要求 4H ADX ≥ 此值（趨勢強度，擋震盪盤；0=關）
    longEmaTrend        = 0,      // 多單要求 收盤 > EMA(此週期) 且 EMA 上升（0=關）
    longBlock           = false,  // 直接封鎖所有多單（對照組：看空單獨立表現）
  } = opts;

  const btcCandles  = allData["BTCUSDT"] || [];
  const openPos     = [];
  const trades      = [];
  const cooldown    = {};
  let   lossStreak  = 0;  // 連虧計數（供 lossStreakReduce 使用）

  for (const ts of times) {
    // ── 出場 ──────────────────────────────────────────────────────────────────
    const curTrend = btcFilter ? btcTrend(btcCandles, ts, { band: btcBand, prevOffset: btcPrevOffset, method: btcMethod }) : 0;

    for (const pos of [...openPos]) {
      const candles = allData[pos.symbol];
      const idx     = candles.findIndex(c => c.time === ts);
      if (idx < 0) continue;
      const candle  = candles[idx];

      // 趨勢翻轉出場
      if (trendExit || trendTightenSL) {
        const againstTrend = (curTrend === -1 && pos.side === "long") ||
                             (curTrend ===  1 && pos.side === "short");
        if (againstTrend) {
          if (trendExit) {
            // A: 直接平倉
            const gross = pos.side === "long"
              ? (candle.close - pos.entryPrice) * pos.quantity
              : (pos.entryPrice - candle.close) * pos.quantity;
            const pnl = gross - feeFor(pos.quantity, pos.entryPrice, candle.close);
            const win = pnl > 0;
            trades.push({ entryTime: pos.entryTime, exitTime: ts, symbol: pos.symbol, side: pos.side, pnl, win, reason: "趨勢翻轉平倉" });
            if (lossStreakReduce) lossStreak = win ? 0 : lossStreak + 1;
            cooldown[pos.symbol] = ts;
            openPos.splice(openPos.indexOf(pos), 1);
            continue;
          } else if (trendTightenSL) {
            // B: 移 SL 到保本（只收緊，不放鬆）
            if (pos.side === "long" && pos.stopLoss < pos.entryPrice) {
              pos.stopLoss = pos.entryPrice;
            } else if (pos.side === "short" && pos.stopLoss > pos.entryPrice) {
              pos.stopLoss = pos.entryPrice;
            }
          }
        }
      }

      // 時間止損：持倉 ≥ timeSLBars 根且未達 0.5R 獲利 → 平倉
      if (timeSL) {
        const barsHeld = (ts - pos.entryTime) / MS_CANDLE;
        if (barsHeld >= timeSLBars) {
          const risk   = Math.abs(pos.entryPrice - pos.stopLoss);
          const profit = pos.side === "long"
            ? candle.close - pos.entryPrice
            : pos.entryPrice - candle.close;
          if (profit < risk * 0.5) {
            const gross = pos.side === "long"
              ? (candle.close - pos.entryPrice) * pos.quantity
              : (pos.entryPrice - candle.close) * pos.quantity;
            const pnl = gross - feeFor(pos.quantity, pos.entryPrice, candle.close);
            trades.push({ entryTime: pos.entryTime, exitTime: ts, symbol: pos.symbol, side: pos.side, pnl, win: pnl > 0, reason: "時間止損" });
            cooldown[pos.symbol] = ts;
            openPos.splice(openPos.indexOf(pos), 1);
            continue;
          }
        }
      }

      // 分批止盈：到達 1.5R 時平一半
      if (partialTP && !pos.halfClosed) {
        const risk      = Math.abs(pos.entryPrice - pos.stopLoss);
        const target15R = pos.side === "long" ? pos.entryPrice + risk * 1.5 : pos.entryPrice - risk * 1.5;
        const hit15R    = pos.side === "long" ? candle.high >= target15R : candle.low <= target15R;
        if (hit15R) {
          const halfQty = pos.quantity / 2;
          const gross   = pos.side === "long"
            ? (target15R - pos.entryPrice) * halfQty
            : (pos.entryPrice - target15R) * halfQty;
          const pnl     = gross - feeFor(halfQty, pos.entryPrice, target15R);
          trades.push({ entryTime: pos.entryTime, exitTime: ts, symbol: pos.symbol, side: pos.side, pnl, win: pnl > 0, reason: "分批止盈" });
          pos.quantity   = halfQty;
          pos.halfClosed = true;
        }
      }

      const { exit, ep, reason } = checkExit(pos, candle, trailStart, fixTrailAfterBreakeven);
      if (exit) {
        const gross = pos.side === "long"
          ? (ep - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - ep) * pos.quantity;
        const pnl = gross - feeFor(pos.quantity, pos.entryPrice, ep);
        const win = pnl > 0;
        trades.push({ entryTime: pos.entryTime, exitTime: ts, symbol: pos.symbol, side: pos.side, pnl, win, reason });
        if (lossStreakReduce) lossStreak = win ? 0 : lossStreak + 1;
        cooldown[pos.symbol] = ts;
        openPos.splice(openPos.indexOf(pos), 1);
      }
    }

    // ── 入場 ──────────────────────────────────────────────────────────────────
    if (openPos.length >= maxOpen) continue;

    // 時段過濾：跳過 UTC 00:00–08:00 開盤的 4H 棒（低流動性）
    if (timeFilter) {
      const hourUtc = (ts % (24 * 3600 * 1000)) / 3600000;
      if (hourUtc < 8) continue;
    }

    const trend = curTrend;

    for (const [symbol, candles] of Object.entries(allData)) {
      if (symbol === "BTCUSDT") continue;
      if (openPos.length >= maxOpen) break;
      if (openPos.some(p => p.symbol === symbol)) continue;
      if (cooldown[symbol] && ts - cooldown[symbol] < COOLDOWN_BARS * MS_CANDLE) continue;

      const idx = candles.findIndex(c => c.time === ts);
      if (idx < LOOKBACK || candles[idx].time < cutoff) continue;

      const slice = candles.slice(0, idx + 1);
      const price = candles[idx].close;
      const sig   = checkSignal(slice, volRatio, adapt);
      if (!sig) continue;

      // BTC 方向過濾
      if (btcFilter && trend !== 0) {
        if (trend === 1 && sig.side === "short") continue;
        if (trend === -1 && sig.side === "long")  continue;
      }

      // 資金費代理過濾：BTC 比 SMA25 高 >3% 時跳過做多
      if (fundingProxy && sig.side === "long") {
        const btcIdx = btcCandles.findIndex(c => c.time === ts);
        if (btcIdx >= SMA_PERIOD) {
          const btcCloses = btcCandles.slice(0, btcIdx + 1).map(c => c.close);
          const btcSma    = smaOf(btcCloses, SMA_PERIOD);
          const btcPrice  = btcCandles[btcIdx].close;
          if (btcPrice > btcSma * 1.03) continue;
        }
      }

      // ATR 波動率過濾：ATR/price < 0.5% 或 > 8% 跳過（太平靜或太亂）
      if (atrFilter) {
        const atr    = atrOf(slice, 14);
        const atrPct = atr / price;
        if (atrPct < 0.005 || atrPct > 0.08) continue;
      }

      // 空頭嚴格確認：BTC 橫盤（trend=0）時，空頭需量能 > 2x 才進場
      if (strictSidewaysShort && sig.side === "short" && trend === 0) {
        const last  = slice[slice.length - 1];
        const volR  = last.volume / avgVolOf(slice, 20);
        if (volR < 2.0) continue;
      }

      // 多時框確認：個幣 1D SMA 方向需與信號一致
      if (dailyData && dailyData[symbol]) {
        const dTrend = dailyTrend(dailyData[symbol], ts, mtfBand);
        if (dTrend !== 0 && dTrend !== (sig.side === "long" ? 1 : -1)) continue;
      }

      // 同向持倉上限
      const sameDirCount = openPos.filter(p => p.side === sig.side).length;
      if (sameDirCount >= maxSameDir) continue;
      // 多頭專屬上限
      if (sig.side === "long" && openPos.filter(p => p.side === "long").length >= maxLong) continue;

      const slPct    = Math.abs(price - sig.stopLoss) / price;

      // 多頭專屬品質過濾
      if (sig.side === "long") {
        if (longBlock) continue;             // 對照組：完全不做多
        if (slPct > longMaxSlPct) continue;  // SL 太寬跳過
        const last = candles[idx];
        const volR = last.volume / avgVolOf(candles.slice(0, idx + 1), 20);
        const body = Math.abs(last.close - last.open);
        const str  = body / (last.high - last.low || 0.0001);
        if (longVolRatio   !== null && volR < longVolRatio)   continue;
        if (longStrength   !== null && str  < longStrength)   continue;
        // ── regime 濾網 ──
        if (longRequireDailyUp) {
          const dd = dailyData && dailyData[symbol] ? dailyTrend(dailyData[symbol], ts, mtfBand) : 0;
          if (dd !== 1) continue;            // 1D 沒有明確上升就不做多
        }
        if (longAdxMin > 0) {
          const adx = adxOf(slice, 14);
          if (adx === null || adx < longAdxMin) continue;   // 趨勢太弱（震盪）不做多
        }
        if (longEmaTrend > 0) {
          const closes = slice.map(c => c.close);
          const emaNow  = emaOf(closes, longEmaTrend);
          const emaPrev = emaOf(closes.slice(0, -SMA_PREV_OFFSET), longEmaTrend);
          if (emaNow === null || emaPrev === null) continue;
          if (!(price > emaNow && emaNow > emaPrev)) continue;  // 需站上且 EMA 上升
        }
      }
      // 空頭專屬品質過濾
      if (sig.side === "short") {
        if (slPct > shortMaxSlPct) continue;
        const last = candles[idx];
        const volR = last.volume / avgVolOf(candles.slice(0, idx + 1), 20);
        const body = Math.abs(last.close - last.open);
        const str  = body / (last.high - last.low || 0.0001);
        if (shortVolRatio  !== null && volR < shortVolRatio)  continue;
        if (shortStrength  !== null && str  < shortStrength)  continue;
      }

      const riskMult = (lossStreakReduce && lossStreak >= 3) ? 0.5 : 1.0;
      const rawSize  = slPct > 0.001 ? (PORTFOLIO * RISK_PCT * riskMult) / slPct : PORTFOLIO * RISK_PCT * riskMult;
      const size     = Math.min(rawSize, MAX_TRADE_USD);

      // 套用可調 TP 比例
      const tp = sig.side === "long"
        ? price + (price - sig.stopLoss) * tpRatio
        : price - (sig.stopLoss - price) * tpRatio;

      openPos.push({
        symbol, side: sig.side, entryPrice: price,
        entryTime: ts, stopLoss: sig.stopLoss, initialSL: sig.stopLoss, tp,
        quantity: size / price, halfClosed: false,
      });
    }
  }

  return trades;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const cutoff = Date.now() - MONTHS * 30 * 24 * 3600 * 1000;

  console.log(`\n策略 B (DMC/SMA25) 回測｜${WATCHLIST.length} 幣種｜4H｜過去 ${MONTHS} 個月`);
  if (COMPARE_MODE) console.log("模式：MAX_OPEN 4 vs 6 比較");
  if (FILTER_MODE)  console.log("模式：基準 vs BTC過濾 vs BTC過濾+同向上限");
  console.log("═".repeat(62));

  // 下載資料（filter/optimize 模式需確保 BTCUSDT 在清單內）
  const fetchList = ((FILTER_MODE || OPTIMIZE_MODE || LONGFIX_MODE) && !WATCHLIST.includes("BTCUSDT"))
    ? ["BTCUSDT", ...WATCHLIST]
    : WATCHLIST;

  const allData = {};
  for (let i = 0; i < fetchList.length; i++) {
    const symbol = fetchList[i];
    process.stdout.write(`  [${i + 1}/${fetchList.length}] ${symbol}... `);
    try {
      const candles  = await fetchCandles(symbol);
      const startIdx = candles.findIndex(c => c.time >= cutoff);
      if (startIdx < LOOKBACK) { console.log("資料不足"); continue; }
      allData[symbol] = candles;
      console.log(`${candles.length} 根`);
    } catch (e) {
      console.log(`錯誤: ${e.message}`);
    }
  }

  // 收集時序
  const timeSet = new Set();
  for (const c of Object.values(allData))
    c.filter(b => b.time >= cutoff).forEach(b => timeSet.add(b.time));
  const times = [...timeSet].sort((a, b) => a - b);
  console.log(`\n共 ${times.length} 個時間點，開始模擬...\n`);

  const pfOf = (t) => {
    const w = t.filter(x => x.win).reduce((s, x) => s + x.pnl, 0);
    const l = Math.abs(t.filter(x => !x.win).reduce((s, x) => s + x.pnl, 0));
    return l > 0 ? w / l : Infinity;
  };
  const summaryRow = (label, t) => {
    const wr  = t.length ? (t.filter(x => x.win).length / t.length * 100).toFixed(1) : "0";
    const pnl = t.reduce((s, x) => s + x.pnl, 0).toFixed(2);
    const pf  = pfOf(t).toFixed(2);
    const mdd = calcMDD(t).toFixed(1);
    return `  ${label.padEnd(22)} ${String(t.length).padStart(5)}  ${(wr+"%").padStart(6)}  ${("$"+pnl).padStart(9)}  ${pf.padStart(6)}  ${(mdd+"%").padStart(7)}`;
  };

  if (LONGFIX_MODE) {
    // 下載 1D 資料（regime 濾網需要）
    console.log("\n下載 1D 資料（regime 濾網）...");
    const fetch1D = (await import("node-fetch")).default;
    const dailyData = {};
    for (const symbol of Object.keys(allData)) {
      if (symbol === "BTCUSDT") continue;
      try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=400`;
        const r   = await fetch1D(url);
        const d   = await r.json();
        if (Array.isArray(d) && d.length) { dailyData[symbol] = d.map(k => ({ time: k[0], close: +k[4] })); process.stdout.write("."); }
      } catch {}
    }
    console.log(`\n完成（${Object.keys(dailyData).length} 幣）\n`);

    // BASE = 現行 LIVE 等效設定（maxOpen 依 MAX_OPEN，建議跑 4 對齊實盤）
    const BASE = {
      btcFilter: true, dailyData, mtfBand: 0.001, trailStart: 0.75,
      fundingProxy: true, trendTightenSL: true,
      tpRatio: 1.25, longMaxSlPct: 0.10, timeSL: true, timeSLBars: 60,
    };
    const scenarios = [
      { label: "現行(LIVE等效)",          opts: { ...BASE } },
      { label: "多單:1D須明確上升",        opts: { ...BASE, longRequireDailyUp: true } },
      { label: "多單:ADX≥20",             opts: { ...BASE, longAdxMin: 20 } },
      { label: "多單:ADX≥25",             opts: { ...BASE, longAdxMin: 25 } },
      { label: "多單:站上EMA50且上升",     opts: { ...BASE, longEmaTrend: 50 } },
      { label: "多單:1D上升+ADX≥20",      opts: { ...BASE, longRequireDailyUp: true, longAdxMin: 20 } },
      { label: "對照:完全不做多(只空)",     opts: { ...BASE, longBlock: true } },
    ];

    const dirStats = (t, side) => {
      const s = t.filter(x => x.side === side);
      if (!s.length) return { n: 0, wr: 0, pnl: 0, pf: 0 };
      const w = s.filter(x => x.win).reduce((a, x) => a + x.pnl, 0);
      const l = Math.abs(s.filter(x => !x.win).reduce((a, x) => a + x.pnl, 0));
      return { n: s.length, wr: s.filter(x => x.win).length / s.length * 100, pnl: s.reduce((a, x) => a + x.pnl, 0), pf: l > 0 ? w / l : Infinity };
    };
    const agg = (t) => {
      const w = t.filter(x => x.win).reduce((s, x) => s + x.pnl, 0);
      const l = Math.abs(t.filter(x => !x.win).reduce((s, x) => s + x.pnl, 0));
      return { n: t.length, wr: t.length ? t.filter(x => x.win).length / t.length * 100 : 0, pnl: t.reduce((s, x) => s + x.pnl, 0), pf: l > 0 ? w / l : Infinity, mdd: calcMDD(t) };
    };

    // 樣本內/外拆分點：整段時間的 65% 為界
    const splitTs = times[Math.floor(times.length * 0.65)];
    const splitDate = new Date(splitTs).toISOString().slice(0, 10);

    const results = [];
    for (const sc of scenarios) {
      process.stdout.write(`  ${sc.label}... `);
      const t = runSimulation(allData, times, cutoff, MAX_OPEN, sc.opts);
      const inS  = t.filter(x => x.entryTime <  splitTs);
      const outS = t.filter(x => x.entryTime >= splitTs);
      console.log(`${t.length} 筆`);
      results.push({ label: sc.label, all: agg(t), lng: dirStats(t, "long"), sht: dirStats(t, "short"), inS: agg(inS), outS: agg(outS) });
    }

    const pfS = (v) => v.pf === Infinity ? "∞" : v.pf.toFixed(2);
    console.log(`\n${"═".repeat(104)}`);
    console.log(`  多單 regime 濾網驗證（${MONTHS}個月, ${Object.keys(allData).length - 1}幣, MAX_OPEN=${MAX_OPEN}, 含手續費）`);
    console.log(`${"─".repeat(104)}`);
    console.log(`  ${"方案".padEnd(26)} ${"筆".padStart(4)} ${"勝率".padStart(6)} ${"PnL".padStart(8)} ${"PF".padStart(5)} ${"MDD".padStart(6)} | ${"多頭 n/勝/PF/PnL".padEnd(24)} ${"空頭 n/勝/PF/PnL"}`);
    console.log(`  ${"─".repeat(101)}`);
    for (const r of results) {
      const a = r.all;
      const lngStr = `${r.lng.n}/${r.lng.wr.toFixed(0)}%/${pfS(r.lng)}/$${r.lng.pnl.toFixed(0)}`;
      const shtStr = `${r.sht.n}/${r.sht.wr.toFixed(0)}%/${pfS(r.sht)}/$${r.sht.pnl.toFixed(0)}`;
      const flag = r !== results[0] && a.pf > results[0].all.pf ? " ✓" : "";
      console.log(
        `  ${r.label.padEnd(26)} ${String(a.n).padStart(4)} ${(a.wr.toFixed(1)+"%").padStart(6)} ${("$"+a.pnl.toFixed(0)).padStart(8)} ${pfS(a).padStart(5)} ${(a.mdd.toFixed(0)+"%").padStart(6)} | ${lngStr.padEnd(24)} ${shtStr}${flag}`
      );
    }
    console.log(`${"═".repeat(104)}`);

    console.log(`\n  樣本內/外拆分（界: ${splitDate}，前65%=樣本內 / 後35%=樣本外）—— 檢驗是否只擬合近期`);
    console.log(`  ${"─".repeat(78)}`);
    console.log(`  ${"方案".padEnd(26)} ${"樣本內 n/PF/PnL".padEnd(24)} ${"樣本外 n/PF/PnL"}`);
    console.log(`  ${"─".repeat(78)}`);
    for (const r of results) {
      const inStr  = `${r.inS.n}/${pfS(r.inS)}/$${r.inS.pnl.toFixed(0)}`;
      const outStr = `${r.outS.n}/${pfS(r.outS)}/$${r.outS.pnl.toFixed(0)}`;
      console.log(`  ${r.label.padEnd(26)} ${inStr.padEnd(24)} ${outStr}`);
    }
    console.log(`  ${"─".repeat(78)}\n`);

  } else if (OPTIMIZE_MODE) {
    // 下載 1D 資料供 MTF 使用
    console.log("\n下載 1D 資料（多時框確認）...");
    const fetch1D  = (await import("node-fetch")).default;
    const dailyData = {};
    for (const symbol of Object.keys(allData)) {
      if (symbol === "BTCUSDT") continue;
      try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=400`;
        const r   = await fetch1D(url);
        const d   = await r.json();
        if (Array.isArray(d) && d.length) {
          dailyData[symbol] = d.map(k => ({ time: k[0], close: +k[4] }));
          process.stdout.write(".");
        }
      } catch {}
    }
    console.log(`\n完成（${Object.keys(dailyData).length} 幣）\n`);

    // 現行最佳設定（BTC過濾 + 1D MTF + trailing 0.75R + 資金費代理 + Step2a）
    const BASE_BEST = { btcFilter: true, dailyData, mtfBand: 0.001, trailStart: 0.75, fundingProxy: true, trendTightenSL: true };

    const BASE = { ...BASE_BEST, tpRatio: 1.25, longMaxSlPct: 0.10, timeSL: true, timeSLBars: 60 };
    const scenarios = [
      { label: "現行固定門檻",         opts: { ...BASE } },
      { label: "自適應量比 k=2",       opts: { ...BASE, adapt: { kVol: 2 } } },
      { label: "自適應量比 k=4",       opts: { ...BASE, adapt: { kVol: 4 } } },
      { label: "自適應強度 k=2",       opts: { ...BASE, adapt: { kStr: 2 } } },
      { label: "自適應 量比+強度 k=2", opts: { ...BASE, adapt: { kVol: 2, kStr: 2 } } },
      { label: "反向:高波動放寬 k=-2", opts: { ...BASE, adapt: { kVol: -2 } } },
    ];

    // 輔助：計算方向拆解
    const dirStats = (t, side) => {
      const s = t.filter(x => x.side === side);
      if (!s.length) return { n: 0, wr: 0, pnl: 0, pf: 0 };
      const w   = s.filter(x => x.win).reduce((a, x) => a + x.pnl, 0);
      const l   = Math.abs(s.filter(x => !x.win).reduce((a, x) => a + x.pnl, 0));
      return { n: s.length, wr: s.filter(x => x.win).length / s.length * 100, pnl: s.reduce((a, x) => a + x.pnl, 0), pf: l > 0 ? w / l : Infinity };
    };

    const results = [];
    for (const sc of scenarios) {
      process.stdout.write(`  ${sc.label}... `);
      const t = runSimulation(allData, times, cutoff, MAX_OPEN, sc.opts);
      const w = t.filter(x => x.win).reduce((s, x) => s + x.pnl, 0);
      const l = Math.abs(t.filter(x => !x.win).reduce((s, x) => s + x.pnl, 0));
      const pf  = l > 0 ? w / l : Infinity;
      const pnl = t.reduce((s, x) => s + x.pnl, 0);
      const wr  = t.length ? t.filter(x => x.win).length / t.length * 100 : 0;
      const mdd = calcMDD(t);
      const lng = dirStats(t, "long");
      const sht = dirStats(t, "short");
      console.log(`${t.length} 筆`);
      results.push({ label: sc.label, n: t.length, wr, pnl, pf, mdd, lng, sht });
    }

    console.log(`\n${"═".repeat(100)}`);
    console.log(`  優化方案比較（${MONTHS}個月, 55幣, MAX_OPEN=6, BTC過濾為基底）`);
    console.log(`${"─".repeat(100)}`);
    console.log(`  ${"方案".padEnd(28)} ${"筆".padStart(4)}  ${"勝率".padStart(5)}  ${"PnL".padStart(8)}  ${"PF".padStart(5)}  ${"MDD".padStart(6)}  |  多頭(n/PF/PnL)        空頭(n/PF/PnL)`);
    console.log(`  ${"─".repeat(97)}`);
    for (const r of results) {
      const better = r !== results[0] && r.pf > results[0].pf ? " ✓" : "";
      const lngStr = `${r.lng.n}/${r.lng.pf === Infinity ? "∞" : r.lng.pf.toFixed(2)}/$${r.lng.pnl.toFixed(0)}`;
      const shtStr = `${r.sht.n}/${r.sht.pf === Infinity ? "∞" : r.sht.pf.toFixed(2)}/$${r.sht.pnl.toFixed(0)}`;
      console.log(
        `  ${r.label.padEnd(28)} ${String(r.n).padStart(4)}  ${(r.wr.toFixed(1)+"%").padStart(5)}` +
        `  ${("$"+r.pnl.toFixed(0)).padStart(8)}  ${r.pf.toFixed(2).padStart(5)}  ${(r.mdd.toFixed(1)+"%").padStart(6)}` +
        `  |  ${lngStr.padEnd(22)} ${shtStr}${better}`
      );
    }
    console.log(`${"═".repeat(100)}\n`);

  } else if (FILTER_MODE) {
    console.log("  [1/3] 基準（無過濾）...");
    const tBase = runSimulation(allData, times, cutoff, 6);
    console.log(`  完成：${tBase.length} 筆`);

    console.log("  [2/3] BTC 方向過濾...");
    const tBtc  = runSimulation(allData, times, cutoff, 6, { btcFilter: true });
    console.log(`  完成：${tBtc.length} 筆`);

    console.log("  [3/3] BTC 過濾 + 同向上限3...");
    const tBtcDir = runSimulation(allData, times, cutoff, 6, { btcFilter: true, maxSameDir: 3 });
    console.log(`  完成：${tBtcDir.length} 筆\n`);

    printReport("基準", tBase, 6);
    printReport("BTC過濾", tBtc, 6);
    printReport("BTC過濾+同向上限", tBtcDir, 6);

    console.log(`\n${"═".repeat(70)}`);
    console.log("  三路比較摘要");
    console.log(`${"─".repeat(70)}`);
    console.log(`  方案                    筆數    勝率      總損益      PF      MDD`);
    console.log(`  ${"─".repeat(65)}`);
    console.log(summaryRow("基準（無過濾）", tBase));
    console.log(summaryRow("BTC方向過濾", tBtc));
    console.log(summaryRow("BTC過濾+同向上限3", tBtcDir));
    console.log(`${"═".repeat(70)}\n`);

  } else if (COMPARE_MODE) {
    console.log("  模擬 MAX_OPEN=4...");
    const trades4 = runSimulation(allData, times, cutoff, 4);
    console.log(`  完成：${trades4.length} 筆\n`);

    console.log("  模擬 MAX_OPEN=6...");
    const trades6 = runSimulation(allData, times, cutoff, 6);
    console.log(`  完成：${trades6.length} 筆`);

    printReport("MAX_OPEN=4", trades4, 4);
    printReport("MAX_OPEN=6", trades6, 6);

    console.log(`\n${"═".repeat(62)}`);
    console.log("  比較摘要");
    console.log(`${"─".repeat(62)}`);
    console.log(`  項目            MAX_OPEN=4      MAX_OPEN=6`);
    console.log(`  筆數            ${String(trades4.length).padStart(8)}        ${String(trades6.length).padStart(8)}`);
    const wr4 = (trades4.filter(t => t.win).length / trades4.length * 100).toFixed(1);
    const wr6 = (trades6.filter(t => t.win).length / trades6.length * 100).toFixed(1);
    console.log(`  勝率            ${(wr4 + "%").padStart(8)}        ${(wr6 + "%").padStart(8)}`);
    const pnl4 = trades4.reduce((s, t) => s + t.pnl, 0).toFixed(2);
    const pnl6 = trades6.reduce((s, t) => s + t.pnl, 0).toFixed(2);
    console.log(`  總損益          ${("$" + pnl4).padStart(8)}        ${("$" + pnl6).padStart(8)}`);
    console.log(`  Profit Factor   ${String(pfOf(trades4).toFixed(2)).padStart(8)}        ${String(pfOf(trades6).toFixed(2)).padStart(8)}`);
    console.log(`  MDD             ${(calcMDD(trades4).toFixed(1) + "%").padStart(8)}        ${(calcMDD(trades6).toFixed(1) + "%").padStart(8)}`);
    console.log(`${"═".repeat(62)}\n`);
  } else {
    console.log(`  模擬 MAX_OPEN=${MAX_OPEN}...`);
    const trades = runSimulation(allData, times, cutoff, MAX_OPEN);
    console.log(`  完成：${trades.length} 筆`);
    printReport(`MAX_OPEN=${MAX_OPEN}`, trades, MAX_OPEN);
    console.log();
  }
}

main().catch(console.error);
