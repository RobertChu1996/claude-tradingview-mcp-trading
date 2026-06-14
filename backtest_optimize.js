/**
 * 參數優化回測 v2 — 指標預計算版，速度快 100x
 * 所有指標只算一次，模擬時 O(1) 查表
 * 執行：node backtest_optimize.js
 */

const COMBOS = [
  { name: "① Baseline",                    minSlPct: 0.2, tpRatio: 2.0, adxMin: 20, btcFilter: false },
  { name: "② SL≥0.6%",                    minSlPct: 0.6, tpRatio: 2.0, adxMin: 20, btcFilter: false },
  { name: "③ SL≥0.8%",                    minSlPct: 0.8, tpRatio: 2.0, adxMin: 20, btcFilter: false },
  { name: "④ BTC Filter",                  minSlPct: 0.2, tpRatio: 2.0, adxMin: 20, btcFilter: true  },
  { name: "⑤ TP 1.5:1",                   minSlPct: 0.2, tpRatio: 1.5, adxMin: 20, btcFilter: false },
  { name: "⑥ ADX≥28",                     minSlPct: 0.2, tpRatio: 2.0, adxMin: 28, btcFilter: false },
  { name: "⑦ SL≥0.6%+BTC",              minSlPct: 0.6, tpRatio: 2.0, adxMin: 20, btcFilter: true  },
  { name: "⑧ SL≥0.6%+TP1.5",           minSlPct: 0.6, tpRatio: 1.5, adxMin: 20, btcFilter: false },
  { name: "⑨ BTC+TP1.5",               minSlPct: 0.2, tpRatio: 1.5, adxMin: 20, btcFilter: true  },
  { name: "⑩ SL0.6+BTC+ADX28",         minSlPct: 0.6, tpRatio: 2.0, adxMin: 28, btcFilter: true  },
  { name: "⑪ SL0.6+BTC+TP1.5",        minSlPct: 0.6, tpRatio: 1.5, adxMin: 20, btcFilter: true  },
  { name: "⑫ SL0.8+BTC+ADX28+TP1.5",  minSlPct: 0.8, tpRatio: 1.5, adxMin: 28, btcFilter: true  },
];

const SYMBOLS = [
  "HIGHUSDT","TRUMPUSDT","BLURUSDT","ZECUSDT","SOLUSDT","ETHUSDT","MOVRUSDT",
  "XRPUSDT","ORDIUSDT","FILUSDT","BTCUSDT","WLDUSDT","OPUSDT","POLUSDT","WIFUSDT",
  "DOTUSDT","BOMEUSDT","ENSUSDT","XLMUSDT","AAVEUSDT","AVAXUSDT","BCHUSDT",
  "DEXEUSDT","NEIROUSDT","BNBUSDT","CFXUSDT","BIOUSDT","TAOUSDT","GALAUSDT",
  "PENGUUSDT","HBARUSDT","EDUUSDT","SUIUSDT","ONDOUSDT","APEUSDT","CHZUSDT",
  "DYDXUSDT","ETCUSDT","DOGEUSDT","LINKUSDT","NEARUSDT","LDOUSDT","ALGOUSDT",
  "STRKUSDT","DASHUSDT","GUNUSDT","PYTHUSDT","LTCUSDT","SEIUSDT","RENDERUSDT",
  "BBUSDT","ADAUSDT","CRVUSDT","UNIUSDT",
];

const INTERVAL  = "1h";
const MONTHS    = 12;
const PORTFOLIO = 1000;
const RISK      = 10;   // 1% of 1000
const MAX_TRADE = 100;
const MAX_OPEN  = 4;
const LOOKBACK  = 60;

// ─── 抓資料 ───────────────────────────────────────────────────────────────────
async function fetchCandles(symbol) {
  const need = MONTHS * 30 * 24;
  let all = [], et = Date.now();
  while (all.length < need) {
    const limit = Math.min(1000, need - all.length);
    const url   = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&endTime=${et}&limit=${limit}`;
    const res   = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const data  = await res.json();
    if (!data.length) break;
    all.unshift(...data.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })));
    et = data[0][0] - 1;
  }
  return all;
}

// ─── 預計算指標（每幣只跑一次）──────────────────────────────────────────────
function precompute(candles) {
  const n      = candles.length;
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const vols   = candles.map(c => c.volume);

  // EMA
  function emaArr(period) {
    const k = 2 / (period + 1);
    const out = new Float64Array(n).fill(NaN);
    if (n < period) return out;
    let val = 0;
    for (let i = 0; i < period; i++) val += closes[i];
    val /= period;
    out[period - 1] = val;
    for (let i = period; i < n; i++) { val = closes[i] * k + val * (1 - k); out[i] = val; }
    return out;
  }

  // RSI — 簡單平均（與原始 calcRSI 一致，只看最近 period+1 根）
  function rsiArr(period) {
    const out = new Float64Array(n).fill(NaN);
    for (let i = period; i < n; i++) {
      let g = 0, l = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const d = closes[j] - closes[j - 1];
        if (d > 0) g += d; else l -= d;
      }
      const rs = g / (l || 1e-9);
      out[i] = 100 - 100 / (1 + rs);
    }
    return out;
  }

  // ATR
  function atrArr(period) {
    const out = new Float64Array(n).fill(NaN);
    if (n < period + 1) return out;
    let sum = 0;
    for (let i = 1; i <= period; i++) {
      sum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    }
    out[period] = sum / period;
    for (let i = period + 1; i < n; i++) {
      const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
      out[i] = (out[i-1] * (period - 1) + tr) / period;
    }
    return out;
  }

  // ADX — Wilder smoothing on TR/DM, then smooth DX to get true ADX
  function adxArr(period) {
    const out = new Float64Array(n).fill(0);
    if (n < period * 2 + 2) return out;
    // Phase 1: Wilder-smooth TR, +DM, -DM
    let sTR = 0, sDMp = 0, sDMm = 0;
    for (let i = 1; i <= period; i++) {
      const up = highs[i] - highs[i-1], dn = lows[i-1] - lows[i];
      sDMp += up > dn && up > 0 ? up : 0;
      sDMm += dn > up && dn > 0 ? dn : 0;
      sTR  += Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
    }
    const dx = new Float64Array(n).fill(0);
    dx[period] = calcDX(sTR, sDMp, sDMm);
    for (let i = period + 1; i < n; i++) {
      const up = highs[i]-highs[i-1], dn = lows[i-1]-lows[i];
      const tr = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
      sTR  = sTR  - sTR/period  + tr;
      sDMp = sDMp - sDMp/period + (up>dn && up>0 ? up : 0);
      sDMm = sDMm - sDMm/period + (dn>up && dn>0 ? dn : 0);
      dx[i] = calcDX(sTR, sDMp, sDMm);
    }
    // Phase 2: smooth DX → ADX
    let adxVal = 0;
    for (let i = period; i < period * 2; i++) adxVal += dx[i];
    adxVal /= period;
    out[period * 2 - 1] = adxVal;
    for (let i = period * 2; i < n; i++) {
      adxVal = (adxVal * (period - 1) + dx[i]) / period;
      out[i] = adxVal;
    }
    return out;
    function calcDX(tr, dmp, dmm) {
      const dip = tr ? dmp/tr*100 : 0, dim = tr ? dmm/tr*100 : 0;
      return (dip+dim) ? Math.abs(dip-dim)/(dip+dim)*100 : 0;
    }
  }

  // VWAP（每日 UTC 00:00 重置，與原版 calcVWAP 邏輯一致）
  function vwapArr() {
    const out = new Float64Array(n).fill(NaN);
    let cumTPV = 0, cumVol = 0, lastDay = -1;
    for (let i = 0; i < n; i++) {
      const dayUTC = Math.floor(candles[i].time / 86400000); // UTC day index
      if (dayUTC !== lastDay) { cumTPV = 0; cumVol = 0; lastDay = dayUTC; }
      cumTPV += (highs[i] + lows[i] + closes[i]) / 3 * vols[i];
      cumVol += vols[i];
      out[i] = cumVol ? cumTPV / cumVol : NaN;
    }
    return out;
  }

  // Swing Low/High (rolling window, 先求 lookback 根的 min/max)
  function swingLowArr(lb) {
    const out = new Float64Array(n).fill(NaN);
    for (let i = lb; i < n; i++) {
      let mn = Infinity;
      for (let j = i - lb; j < i; j++) if (lows[j] < mn) mn = lows[j];
      out[i] = mn;
    }
    return out;
  }
  function swingHighArr(lb) {
    const out = new Float64Array(n).fill(NaN);
    for (let i = lb; i < n; i++) {
      let mx = -Infinity;
      for (let j = i - lb; j < i; j++) if (highs[j] > mx) mx = highs[j];
      out[i] = mx;
    }
    return out;
  }

  // Vol 20-bar avg
  function volAvgArr(period) {
    const out = new Float64Array(n).fill(NaN);
    for (let i = period; i < n; i++) {
      let s = 0; for (let j = i - period; j < i; j++) s += vols[j];
      out[i] = s / period;
    }
    return out;
  }

  const e8   = emaArr(8);
  const e21  = emaArr(21);
  const e50  = emaArr(50);
  // EMA21 3 bars ago (用 e21[i-3] 近似斜率)
  const r3   = rsiArr(3);
  const r14  = rsiArr(14);
  const atr  = atrArr(14);
  const adx  = adxArr(14);
  const vwap = vwapArr();
  const sl5  = swingLowArr(5);
  const sl8  = swingLowArr(8);
  const sh5  = swingHighArr(5);
  const sh8  = swingHighArr(8);
  const va20 = volAvgArr(20);

  return { closes, highs, lows, vols, e8, e21, e50, r3, r14, atr, adx, vwap, sl5, sl8, sh5, sh8, va20, n };
}

// ─── 信號（O(1) 查表）────────────────────────────────────────────────────────
function sigA(pc, i, p, btcBullish) {
  if (i < LOOKBACK) return null;
  const price = pc.closes[i];
  if (price < 0.001) return null;
  const { e8, vwap, r3, adx, sl5, sh5 } = pc;
  if (isNaN(e8[i]) || isNaN(vwap[i]) || isNaN(r3[i])) return null;
  if (adx[i] < p.adxMin) return null;

  if (price > vwap[i] && price > e8[i] && r3[i] < 20) {
    if (p.btcFilter && !btcBullish) return null;
    const sl    = sl5[i];
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < p.minSlPct || slPct > 1.5 || sl >= price || isNaN(sl)) return null;
    return { side: "long", stopLoss: sl };
  }
  if (price < vwap[i] && price < e8[i] && r3[i] > 80) {
    if (p.btcFilter && btcBullish) return null;
    const sl    = sh5[i];
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < p.minSlPct || slPct > 1.5 || sl <= price || isNaN(sl)) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

function sigE(pc, i, p, btcBullish) {
  if (i < LOOKBACK) return null;
  const price = pc.closes[i];
  if (price < 0.001) return null;
  const { e21, e50, r14, atr, adx, sl8, sh8, va20, vols } = pc;
  if (isNaN(e21[i]) || isNaN(e50[i]) || isNaN(r14[i]) || isNaN(atr[i])) return null;
  if (adx[i] < p.adxMin) return null;

  const isUp   = pc.closes[i] > pc.opens?.[i] || (i > 0 && pc.closes[i] > pc.closes[i-1]);
  const isDown = pc.closes[i] < (pc.opens?.[i] ?? pc.closes[i]);

  // EMA21 slope (compare to 3 bars ago)
  const e21_3 = i >= 3 ? pc.e21[i - 3] : NaN;
  const rising  = e21[i] > e21_3 * 1.0005;
  const falling = e21[i] < e21_3 * 0.9995;
  const volOk   = !isNaN(va20[i]) && vols[i] > va20[i];

  const isUPbar = pc.closes[i] > (i > 0 ? pc.closes[i-1] : pc.closes[i]);
  const isDNbar = pc.closes[i] < (i > 0 ? pc.closes[i-1] : pc.closes[i]);

  if (e21[i] > e50[i] && price > e50[i] && r14[i] >= 35 && r14[i] <= 52 && isUPbar && rising && volOk) {
    if (p.btcFilter && !btcBullish) return null;
    const sl    = sl8[i] - atr[i] * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < p.minSlPct || slPct > 3 || sl >= price || isNaN(sl)) return null;
    return { side: "long", stopLoss: sl };
  }
  if (e21[i] < e50[i] && price < e50[i] && r14[i] >= 48 && r14[i] <= 65 && isDNbar && falling && volOk) {
    if (p.btcFilter && btcBullish) return null;
    const sl    = sh8[i] + atr[i] * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < p.minSlPct || slPct > 3 || sl <= price || isNaN(sl)) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

// ─── 出場（high/low OCO，O(1)）────────────────────────────────────────────────
function trailingStop(pos, closePrice) {
  const { side, entryPrice, stopLoss } = pos;
  const risk = Math.abs(entryPrice - stopLoss);
  if (!risk) return stopLoss;
  const profitR = (side === "long" ? closePrice - entryPrice : entryPrice - closePrice) / risk;
  if (profitR < 1.0) return stopLoss;
  const lockR   = Math.max(0, Math.floor(profitR * 2) / 2 - 1.0);
  const newStop = side === "long" ? entryPrice + risk * lockR : entryPrice - risk * lockR;
  return side === "long" ? Math.max(stopLoss, newStop) : Math.min(stopLoss, newStop);
}

function checkExit(pos, hi, lo, cl, tpRatio) {
  pos.stopLoss = trailingStop(pos, cl);
  const risk = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp   = pos.side === "long" ? pos.entryPrice + risk * tpRatio : pos.entryPrice - risk * tpRatio;
  if (pos.side === "long") {
    const slHit = lo <= pos.stopLoss, tpHit = hi >= tp;
    if (slHit && tpHit) return { exit: true, ep: pos.stopLoss };
    if (tpHit) return { exit: true, ep: tp };
    if (slHit) return { exit: true, ep: pos.stopLoss };
  } else {
    const slHit = hi >= pos.stopLoss, tpHit = lo <= tp;
    if (slHit && tpHit) return { exit: true, ep: pos.stopLoss };
    if (tpHit) return { exit: true, ep: tp };
    if (slHit) return { exit: true, ep: pos.stopLoss };
  }
  return { exit: false };
}

// ─── 模擬 ─────────────────────────────────────────────────────────────────────
function runStrategy(sigFn, precomps, candles, idxMap, times, btcBull, p, label) {
  const openPos = [], trades = [], cooldown = {};
  for (const ts of times) {
    // 出場
    for (const pos of [...openPos]) {
      const idx = idxMap[pos.symbol]?.[ts];
      if (idx === undefined) continue;
      const pc = precomps[pos.symbol];
      const { exit, ep } = checkExit(pos, pc.highs[idx], pc.lows[idx], pc.closes[idx], p.tpRatio);
      if (exit) {
        const pnl = pos.side === "long" ? (ep - pos.entryPrice) * pos.quantity : (pos.entryPrice - ep) * pos.quantity;
        trades.push({ symbol: pos.symbol, pnl, win: pnl > 0 });
        cooldown[pos.symbol] = ts;
        openPos.splice(openPos.indexOf(pos), 1);
      }
    }
    if (openPos.length >= MAX_OPEN) continue;
    const isBull = btcBull[ts];
    for (const symbol of Object.keys(precomps)) {
      if (openPos.length >= MAX_OPEN) break;
      if (openPos.some(pos => pos.symbol === symbol)) continue;
      if (label === "A" && cooldown[symbol] && ts - cooldown[symbol] < 4 * 3600 * 1000) continue;
      const idx = idxMap[symbol]?.[ts];
      if (idx === undefined || idx < LOOKBACK) continue;
      const pc  = precomps[symbol];
      const sig = sigFn(pc, idx, p, isBull);
      if (!sig) continue;
      const price   = pc.closes[idx];
      const slPct   = Math.abs(price - sig.stopLoss) / price;
      const rawSize = slPct > 0.001 ? RISK / slPct : RISK;
      const size    = Math.min(rawSize, PORTFOLIO, MAX_TRADE);
      openPos.push({ symbol, side: sig.side, entryPrice: price, entryTime: ts, stopLoss: sig.stopLoss, quantity: size / price });
    }
  }
  return trades;
}

function stats(trades) {
  if (!trades.length) return { trades: 0, winRate: "—", pnl: "0.00", pf: "—" };
  const wins = trades.filter(t => t.win), losses = trades.filter(t => !t.win);
  const gross = wins.reduce((s, t) => s + t.pnl, 0);
  const loss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  return {
    trades:  trades.length,
    winRate: ((wins.length / trades.length) * 100).toFixed(1) + "%",
    pnl:     trades.reduce((s, t) => s + t.pnl, 0).toFixed(2),
    pf:      loss > 0 ? (gross / loss).toFixed(2) : "∞",
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n最佳化回測 v2｜${SYMBOLS.length}幣｜1H｜12個月｜${COMBOS.length}組合\n`);

  // 1. 抓資料
  const rawData = {};
  for (let i = 0; i < SYMBOLS.length; i++) {
    const sym = SYMBOLS[i];
    process.stdout.write(`  [${i+1}/${SYMBOLS.length}] ${sym}...`);
    try {
      const c = await fetchCandles(sym);
      if (c.length < LOOKBACK * 2) { console.log(" 不足"); continue; }
      rawData[sym] = c;
      console.log(` ${c.length}根`);
    } catch(e) { console.log(` 錯誤`); }
  }

  // 2. 時間軸 + 索引
  const cutoff = Date.now() - MONTHS * 30 * 24 * 3600 * 1000;
  const allTs  = new Set();
  for (const c of Object.values(rawData)) c.forEach(x => { if (x.time >= cutoff) allTs.add(x.time); });
  const times  = [...allTs].sort((a, b) => a - b);

  const idxMap = {};
  for (const [sym, c] of Object.entries(rawData)) {
    idxMap[sym] = {};
    for (let i = 0; i < c.length; i++) idxMap[sym][c[i].time] = i;
  }

  // 3. 預計算指標（一次性）
  console.log(`\n預計算指標...`);
  const precomps = {};
  for (const [sym, c] of Object.entries(rawData)) precomps[sym] = precompute(c);
  console.log(`完成，共 ${Object.keys(precomps).length} 幣`);

  // 4. BTC 趨勢（EMA50）
  const btcBull = {};
  if (precomps["BTCUSDT"]) {
    const btc = rawData["BTCUSDT"], pc = precomps["BTCUSDT"];
    for (let i = 50; i < btc.length; i++) btcBull[btc[i].time] = pc.closes[i] > pc.e50[i];
  }

  // 5. 跑 12 組合
  console.log(`\n開始模擬 ${times.length} 個時間點 × ${COMBOS.length} 組合...\n`);
  const results = [];
  for (const p of COMBOS) {
    process.stdout.write(`  ${p.name}...`);
    const tA = runStrategy(sigA, precomps, rawData, idxMap, times, btcBull, p, "A");
    const tE = runStrategy(sigE, precomps, rawData, idxMap, times, btcBull, p, "E");
    results.push({ name: p.name, a: stats(tA), e: stats(tE) });
    console.log(` A:${tA.length}筆 E:${tE.length}筆`);
  }

  // 6. 輸出表格
  const pL = (s, n) => String(s).padEnd(n);
  const pR = (s, n) => String(s).padStart(n);
  const line = "─".repeat(72);

  for (const [label, key] of [["A（VWAP+RSI(3)+EMA）", "a"], ["E（EMA Trend Pullback）", "e"]]) {
    console.log(`\n${"═".repeat(72)}`);
    console.log(`  策略 ${label} — OCO high/low 出場`);
    console.log(`${"═".repeat(72)}`);
    console.log(`  ${pL("組合",26)} ${pR("筆數",5)} ${pR("勝率",7)} ${pR("年損益",9)} ${pR("PF",6)}`);
    console.log(`  ${line}`);
    for (const r of results) {
      const s = r[key];
      const ok = parseFloat(s.pf) >= 1.0 ? " ✅" : "";
      console.log(`  ${pL(r.name,26)} ${pR(s.trades,5)} ${pR(s.winRate,7)} ${pR("$"+s.pnl,9)} ${pR(s.pf,6)}${ok}`);
    }
  }
  console.log(`\n  說明：PF > 1.0 = 正期望值 ✅\n`);
}

main().catch(console.error);
