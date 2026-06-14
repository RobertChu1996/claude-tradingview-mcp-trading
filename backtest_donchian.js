/**
 * Donchian Breakout 參數網格搜尋｜4H｜250幣｜Binance 期貨
 * 只做多（BTC 1200根4H均線 ≈ 200日均線過濾）
 * 執行：node backtest_donchian.js
 */

const INTERVAL     = "1d";
const MONTHS       = 36;    // 3年，樣本足夠
const MAX_SYMBOLS  = 60;
const PORTFOLIO    = 1000;
const RISK         = 10;    // $10/筆 = 1%
const MAX_TRADE    = 200;
const MAX_OPEN     = 8;
const BTC_MA_BARS  = 200;   // 200日均線
const LOOKBACK     = BTC_MA_BARS + 50;
const ATR_PERIOD   = 14;

// 日線參數網格
const GRID = [];
for (const nHigh of [20, 30, 50]) {
  for (const nLow of [5, 10, 15]) {
    for (const tpR of [1.5, 2.0, 3.0]) {
      for (const slMode of ["donchian", "atr"]) {
        GRID.push({ nHigh, nLow, tpR, slMode });
      }
    }
  }
}

// 主流幣清單（按市值排序，BTC 必須在最前面）
const SYMBOL_LIST = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","AVAXUSDT","DOGEUSDT","DOTUSDT","LINKUSDT",
  "LTCUSDT","NEARUSDT","UNIUSDT","AAVEUSDT","ATOMUSDT",
  "FILUSDT","ETCUSDT","XLMUSDT","ALGOUSDT","MATICUSDT",
  "CRVUSDT","INJUSDT","APTUSDT","ARBUSDT","OPUSDT",
  "LDOUSDT","RUNEUSDT","SEIUSDT","SUIUSDT","TIAUSDT",
  "STXUSDT","ORDIUSDT","WLDUSDT","BLURUSDT","PENDLEUSDT",
  "FETUSDT","RENDERUSDT","TAOУСDT","JUPUSDT","ENAUSDT",
  "ONDOUSDT","EIGENUSDT","BCHUSDT","TRXUSDT","ICPUSDT",
  "HBARUSDT","VETUSDT","SANDUSDT","MANAUSDT","AXSUSDT",
  "GALAUSDT","DYDXUSDT","ENSUSDT","GMXUSDT","SNXUSDT",
  "YFIUSDT","COMPUSDT","SUSHIUSDT","1INCHUSDT","ZECUSDT",
].slice(0, MAX_SYMBOLS);

// ─── 抓 K 線（Binance Spot）─────────────────────────────────────────────────
async function fetchCandles(symbol) {
  const need = MONTHS * 31 + LOOKBACK + 20;
  let all = [], et = Date.now();
  while (all.length < need) {
    const limit = Math.min(1000, need - all.length + 20);
    const url   = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&endTime=${et}&limit=${limit}`;
    const res   = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const data  = await res.json();
    if (!data.length) break;
    all.unshift(...data.map(k => ({
      time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5]
    })));
    et = data[0][0] - 1;
    if (data.length < limit) break;
  }
  return all;
}

// ─── 預計算指標 ───────────────────────────────────────────────────────────────
function precompute(candles) {
  const n      = candles.length;
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);

  // ATR (Wilder smoothed)
  const atr = new Float64Array(n).fill(NaN);
  if (n > ATR_PERIOD) {
    let s = 0;
    for (let i = 1; i <= ATR_PERIOD; i++)
      s += Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
    atr[ATR_PERIOD] = s / ATR_PERIOD;
    for (let i = ATR_PERIOD+1; i < n; i++) {
      const tr = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
      atr[i] = (atr[i-1] * (ATR_PERIOD-1) + tr) / ATR_PERIOD;
    }
  }

  // BTC 200日均線等效（1200根4H SMA）
  const maTrend = new Float64Array(n).fill(NaN);
  for (let i = BTC_MA_BARS-1; i < n; i++) {
    let s = 0;
    for (let j = i-BTC_MA_BARS+1; j <= i; j++) s += closes[j];
    maTrend[i] = s / BTC_MA_BARS;
  }

  // Rolling max（highs）/ min（lows）for all grid periods
  const rollMax = {}, rollMin = {};
  const periods = [...new Set([...GRID.map(g=>g.nHigh), ...GRID.map(g=>g.nLow)])];
  for (const p of periods) {
    rollMax[p] = new Float64Array(n).fill(NaN);
    rollMin[p] = new Float64Array(n).fill(NaN);
    // 滑動視窗（deque 優化）
    const maxDq = [], minDq = [];
    for (let i = 0; i < n; i++) {
      while (maxDq.length && highs[maxDq[maxDq.length-1]] <= highs[i]) maxDq.pop();
      while (minDq.length && lows[minDq[minDq.length-1]] >= lows[i]) minDq.pop();
      maxDq.push(i); minDq.push(i);
      if (maxDq[0] <= i-p) maxDq.shift();
      if (minDq[0] <= i-p) minDq.shift();
      if (i >= p-1) { rollMax[p][i] = highs[maxDq[0]]; rollMin[p][i] = lows[minDq[0]]; }
    }
  }

  return { closes, highs, lows, atr, maTrend, rollMax, rollMin, n };
}

// ─── 單組參數模擬 ─────────────────────────────────────────────────────────────
function runDonchian(params, precomps, idxMap, times, symbols) {
  const { nHigh, nLow, tpR, slMode } = params;
  const ATR_SL_MULT = 2.0;
  const COOLDOWN_MS = 3 * 24 * 3600 * 1000; // 3天

  const openPos = [], trades = [], cooldown = {};
  const btcPc = precomps["BTCUSDT"];
  const btcIdx = idxMap["BTCUSDT"] || {};

  for (const ts of times) {
    // 出場
    for (const pos of [...openPos]) {
      const idx = idxMap[pos.symbol]?.[ts];
      if (idx === undefined) continue;
      const pc = precomps[pos.symbol];
      const hi = pc.highs[idx], lo = pc.lows[idx];

      // 追蹤止損（Donchian 低點上移）
      if (slMode === "donchian" && idx >= nLow && !isNaN(pc.rollMin[nLow][idx])) {
        const newSl = pc.rollMin[nLow][idx];
        if (newSl > pos.sl) pos.sl = newSl;
      }

      const slHit = lo <= pos.sl;
      const tpHit = hi >= pos.tp;
      if (slHit || tpHit) {
        const ep  = (slHit && tpHit) ? pos.sl : tpHit ? pos.tp : pos.sl;
        const pnl = (ep - pos.entry) * pos.qty;
        trades.push({ pnl, win: pnl > 0, ts });
        cooldown[pos.symbol] = ts;
        openPos.splice(openPos.indexOf(pos), 1);
      }
    }

    if (openPos.length >= MAX_OPEN) continue;

    // BTC 趨勢過濾
    const bi = btcIdx[ts];
    if (bi === undefined || isNaN(btcPc?.maTrend?.[bi])) continue;
    if (btcPc.closes[bi] < btcPc.maTrend[bi]) continue;

    // 進場掃描
    for (const symbol of symbols) {
      if (openPos.length >= MAX_OPEN) break;
      if (openPos.some(p => p.symbol === symbol)) continue;
      if (cooldown[symbol] && ts - cooldown[symbol] < COOLDOWN_MS) continue;

      const idx = idxMap[symbol]?.[ts];
      if (idx === undefined || idx < LOOKBACK) continue;

      const pc = precomps[symbol];
      if (isNaN(pc.rollMax[nHigh]?.[idx-1])) continue;
      if (isNaN(pc.atr[idx])) continue;

      const prevHigh = pc.rollMax[nHigh][idx-1];
      const cl       = pc.closes[idx];
      if (cl <= prevHigh) continue; // 未突破

      // 止損
      let sl;
      if (slMode === "donchian") {
        if (isNaN(pc.rollMin[nLow]?.[idx])) continue;
        sl = pc.rollMin[nLow][idx];
      } else {
        sl = cl - ATR_SL_MULT * pc.atr[idx];
      }

      const slPct = (cl - sl) / cl;
      if (slPct <= 0.003 || slPct > 0.25) continue;

      const tp  = cl + (cl - sl) * tpR;
      const qty = Math.min(RISK / slPct, MAX_TRADE) / cl;
      openPos.push({ symbol, entry: cl, sl, tp, qty, ts });
    }
  }
  return trades;
}

// ─── 統計 ─────────────────────────────────────────────────────────────────────
function stats(trades) {
  if (!trades.length) return { n:0, wr:"0%", pnl:"0.00", pf:"—", pfNum:0, avgWin:"0.00", avgLoss:"0.00" };
  const wins   = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const gross  = wins.reduce((s,t) => s+t.pnl, 0);
  const loss   = Math.abs(losses.reduce((s,t) => s+t.pnl, 0));
  const pnl    = gross - loss;
  const pf     = loss > 0 ? gross/loss : Infinity;
  return {
    n: trades.length,
    wr: ((wins.length/trades.length)*100).toFixed(0)+"%",
    pnl: pnl.toFixed(2),
    pf: pf === Infinity ? "∞" : pf.toFixed(2),
    pfNum: isFinite(pf) ? pf : 99,
    avgWin: (gross/(wins.length||1)).toFixed(2),
    avgLoss: (-(loss/(losses.length||1))).toFixed(2),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nDonchian Breakout｜日線｜最多 ${MAX_SYMBOLS} 幣｜${MONTHS}個月｜${GRID.length} 組參數\n`);

  const symbols = SYMBOL_LIST.filter(s => !s.includes("Ус")); // 過濾打錯的

  // 抓 K 線
  console.log(`下載 K 線資料（${symbols.length} 幣）：`);
  const rawData = {};
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    process.stdout.write(`  [${String(i+1).padStart(2)}/${symbols.length}] ${sym.padEnd(14)}`);
    try {
      const c = await fetchCandles(sym);
      if (c.length < LOOKBACK + 100) {
        console.log(`跳過（${c.length}根不足）`);
        continue;
      }
      rawData[sym] = c;
      console.log(`${c.length}根`);
    } catch(e) {
      console.log(`錯誤(${e.message})`);
    }
    // 每 20 個幣停頓 500ms 避免 rate limit
    if ((i+1) % 20 === 0) await new Promise(r => setTimeout(r, 500));
  }

  const loaded = Object.keys(rawData);
  console.log(`成功載入 ${loaded.length} 幣`);

  // 預計算
  console.log(`預計算指標（滑動視窗）...`);
  const precomps = {};
  for (const [sym, c] of Object.entries(rawData)) precomps[sym] = precompute(c);

  // 時間軸（只保留回測期內）
  const cutoff = Date.now() - MONTHS * 30 * 24 * 3600 * 1000;
  const allTs  = new Set();
  for (const c of Object.values(rawData)) c.forEach(x => { if (x.time >= cutoff) allTs.add(x.time); });
  const times  = [...allTs].sort((a,b) => a-b);

  const idxMap = {};
  for (const [sym, c] of Object.entries(rawData)) {
    idxMap[sym] = {};
    for (let i = 0; i < c.length; i++) idxMap[sym][c[i].time] = i;
  }

  console.log(`完成｜${times.length} 個 4H 時間點｜開始網格搜尋...\n`);

  // 網格搜尋
  const results = [];
  for (let gi = 0; gi < GRID.length; gi++) {
    const p      = GRID[gi];
    const trades = runDonchian(p, precomps, idxMap, times, loaded);
    const s      = stats(trades);
    results.push({ ...p, ...s });
    const slStr = p.slMode === "donchian" ? "Dnchn" : "ATR×2";
    process.stdout.write(
      `  [${String(gi+1).padStart(2)}/${GRID.length}] N${p.nHigh}/${p.nLow} TP${p.tpR} ${slStr.padEnd(5)} → ` +
      `${String(s.n).padStart(4)}筆 勝率${s.wr.padStart(4)} PF${s.pf}\n`
    );
  }

  // 排序輸出
  results.sort((a,b) => b.pfNum - a.pfNum);

  console.log(`\n${"═".repeat(84)}`);
  console.log(`  Donchian 日線網格結果（按 PF 排序，${loaded.length} 幣，${MONTHS} 個月）`);
  console.log(`${"═".repeat(84)}`);
  console.log(`  N高  N低  TP   止損      筆數  勝率    總損益       PF    均獲利   均虧損`);
  console.log(`  ${"─".repeat(77)}`);
  for (const r of results) {
    const slStr = r.slMode === "donchian" ? "Dnchn" : "ATR×2";
    console.log(
      `  ${String(r.nHigh).padStart(3)}  ${String(r.nLow).padStart(3)}  ${r.tpR.toFixed(1)}  ${slStr.padEnd(7)}` +
      `  ${String(r.n).padStart(4)}  ${r.wr.padStart(4)}  ` +
      `${(+r.pnl>=0?" ":"")}${r.pnl.padStart(10)}  ${String(r.pf).padStart(5)}  ` +
      `$${r.avgWin.padStart(8)}  $${r.avgLoss.padStart(8)}`
    );
  }

  const best = results[0];
  console.log(`\n★ 最佳：N高${best.nHigh} N低${best.nLow} TP${best.tpR} ${best.slMode} → PF ${best.pf}，勝率 ${best.wr}，${best.n} 筆`);
  console.log(`   年化損益 $${best.pnl}（初始資金 $${PORTFOLIO}）\n`);
}

main().catch(console.error);
