/**
 * Donchian 幣種清單優化器
 *
 * 流程：
 * 1. Binance 抓所有 USDT 永續合約，按 24h 成交量排序，取前 TOP_VOL 名
 * 2. 排除穩定幣、槓桿代幣、成交量太低的幣
 * 3. 每幣下載 LOOKBACK_DAYS 日線，跑 Donchian 回測（雙向）
 * 4. PF >= PF_MIN 或交易筆數太少（新幣無法判斷）→ 保留
 * 5. 最終輸出前 MAX_SYMBOLS 名（按 PF 排序，但上限取自成交量 top 名單）
 * 6. 存到 watchlist_dn.json
 */

import { writeFileSync } from "fs";
import { WATCHLIST_DN_FILE } from "./paths.js";

const TOP_VOL      = 120;   // 先抓成交量前N名
const MAX_SYMBOLS  = 80;    // 最終保留幣數
const LOOKBACK_DAYS = 180;  // 回測天數（6個月）
const PF_MIN       = 1.0;   // 最低獲利因子（太少交易則豁免）
const MIN_TRADES_FOR_PF = 3; // 少於此筆數的幣不強制PF過濾
const N_HIGH       = 30;    // Donchian 突破週期
const N_LOW        = 15;    // Donchian 止損週期
const TP_RATIO     = 3.0;
const BTC_MA_BARS  = 200;

// 排除清單：穩定幣、槓桿代幣、指數代幣
const EXCLUDE_PATTERN = /^(USDC|USDT|BUSD|DAI|TUSD|USDP|FDUSD|PYUSD|EUR|GBP|BRL|AUD|2L|2S|3L|3S|BEAR|BULL|UP|DOWN|HEDGE)/i;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// Binance 24h 成交量排行
async function fetchTopByVolume() {
  const tickers = await fetchJson("https://api.binance.com/api/v3/ticker/24hr");
  return tickers
    .filter(t => t.symbol.endsWith("USDT") && !EXCLUDE_PATTERN.test(t.symbol.replace("USDT", "")))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, TOP_VOL)
    .map(t => ({ symbol: t.symbol, volume24h: parseFloat(t.quoteVolume) }));
}

// Issue 4: OKX 合約清單驗證（只保留 OKX 上有掛牌且狀態為 live 的幣）
async function fetchOkxSymbols() {
  try {
    const res = await fetchJson("https://www.okx.com/api/v5/public/instruments?instType=SWAP");
    const ids = new Set(
      (res.data || [])
        .filter(i => i.instId.endsWith("-USDT-SWAP") && i.state === "live")
        .map(i => i.instId.replace("-USDT-SWAP", "USDT"))
    );
    console.log(`  OKX 可交易 USDT-SWAP 合約：${ids.size} 個`);
    return ids;
  } catch(e) {
    console.warn(`  ⚠️ 無法取得OKX合約清單: ${e.message}，跳過OKX過濾`);
    return null;
  }
}

// 日線 K 線
async function fetchDaily(symbol, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`;
  const raw = await fetchJson(url);
  return raw.map(k => ({ time: +k[0], high: +k[2], low: +k[3], close: +k[4] }));
}

// BTC MA200（用來決定回測期間每天的方向）
async function buildBtcBullMap() {
  const candles = await fetchDaily("BTCUSDT", BTC_MA_BARS + LOOKBACK_DAYS + 10);
  const map = {};
  for (let i = BTC_MA_BARS; i < candles.length; i++) {
    const slice = candles.slice(i - BTC_MA_BARS, i);
    const ma = slice.reduce((s, c) => s + c.close, 0) / BTC_MA_BARS;
    const dateStr = new Date(candles[i].time).toISOString().slice(0, 10);
    map[dateStr] = candles[i].close >= ma;
  }
  return map;
}

function rollingHigh(arr, n) { return Math.max(...arr.slice(-n)); }
function rollingLow(arr, n)  { return Math.min(...arr.slice(-n)); }

// 單幣 Donchian 回測，回傳 { pf, trades, grossWin, grossLoss }
function backtestSymbol(candles, btcBullMap) {
  const todayOpen = new Date().setUTCHours(0, 0, 0, 0);
  const bars = candles.filter(c => c.time < todayOpen);

  const lookbackStart = Date.now() - LOOKBACK_DAYS * 86400000;

  let grossWin = 0, grossLoss = 0, trades = 0;
  const neededHistory = N_HIGH + N_LOW;

  for (let i = neededHistory; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.time < lookbackStart) continue;

    const dateStr = new Date(bar.time).toISOString().slice(0, 10);
    const isBull  = btcBullMap[dateStr] ?? true;

    const prev    = bars.slice(i - N_HIGH, i);
    const window  = bars.slice(i - N_LOW, i + 1);

    if (isBull) {
      // 做多：突破前N高
      const prevHigh = rollingHigh(prev.map(b => b.high), N_HIGH);
      if (bar.close <= prevHigh) continue;
      const sl    = rollingLow(window.map(b => b.low), N_LOW);
      const slPct = (bar.close - sl) / bar.close;
      if (sl >= bar.close || slPct < 0.003 || slPct > 0.25) continue;
      const tp   = bar.close + (bar.close - sl) * TP_RATIO;
      const risk = bar.close - sl;

      // 逐根模擬出場
      let exited = false;
      let trailSL = sl;
      for (let j = i + 1; j < bars.length && !exited; j++) {
        const nb = bars[j];
        // 更新追蹤止損
        const newSL = rollingLow(bars.slice(Math.max(0, j - N_LOW), j + 1).map(b => b.low), N_LOW);
        if (newSL > trailSL) trailSL = newSL;

        if (nb.low <= trailSL) { grossLoss += risk; trades++; exited = true; }
        else if (nb.high >= tp) { grossWin += risk * TP_RATIO; trades++; exited = true; }
      }
    } else {
      // 做空：突破前N低
      const prevLow = rollingLow(prev.map(b => b.low), N_HIGH);
      if (bar.close >= prevLow) continue;
      const sl    = rollingHigh(window.map(b => b.high), N_LOW);
      const slPct = (sl - bar.close) / bar.close;
      if (sl <= bar.close || slPct < 0.003 || slPct > 0.25) continue;
      const tp   = bar.close - (sl - bar.close) * TP_RATIO;
      if (tp <= 0) continue;
      const risk = sl - bar.close;

      let exited = false;
      let trailSL = sl;
      for (let j = i + 1; j < bars.length && !exited; j++) {
        const nb = bars[j];
        const newSL = rollingHigh(bars.slice(Math.max(0, j - N_LOW), j + 1).map(b => b.high), N_LOW);
        if (newSL < trailSL) trailSL = newSL;

        if (nb.high >= trailSL) { grossLoss += risk; trades++; exited = true; }
        else if (nb.low <= tp)  { grossWin += risk * TP_RATIO; trades++; exited = true; }
      }
    }
  }

  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  return { pf, trades, grossWin, grossLoss };
}

async function run() {
  console.log("=== Donchian 幣種優化器 ===");
  console.log(`成交量前${TOP_VOL} → 回測${LOOKBACK_DAYS}天 → PF≥${PF_MIN} → 保留前${MAX_SYMBOLS}幣\n`);

  console.log("抓 Binance 24h 成交量排行...");
  const topCoins = await fetchTopByVolume();
  console.log(`  過濾後 ${topCoins.length} 幣`);

  console.log("驗證 OKX 合約清單...");
  const okxSymbols = await fetchOkxSymbols();
  const validCoins = okxSymbols
    ? topCoins.filter(t => okxSymbols.has(t.symbol))
    : topCoins;
  if (okxSymbols) console.log(`  OKX驗證後剩 ${validCoins.length} 幣（排除 ${topCoins.length - validCoins.length} 幣）`);

  console.log("建立 BTC MA200 日期地圖...");
  const btcBullMap = await buildBtcBullMap();

  const results = [];
  for (let i = 0; i < validCoins.length; i++) {
    const { symbol, volume24h } = validCoins[i];
    process.stdout.write(`  [${i+1}/${validCoins.length}] ${symbol.padEnd(12)}`);
    try {
      const candles = await fetchDaily(symbol, BTC_MA_BARS + LOOKBACK_DAYS + 10);
      if (candles.length < BTC_MA_BARS + N_HIGH + N_LOW) {
        console.log("資料不足，跳過");
        continue;
      }
      const { pf, trades } = backtestSymbol(candles, btcBullMap);
      const pass = trades < MIN_TRADES_FOR_PF || pf >= PF_MIN;
      console.log(`trades=${trades} PF=${pf === Infinity ? "∞" : pf.toFixed(2)} ${pass ? "✅" : "❌"}`);
      if (pass) results.push({ symbol, volume24h, pf, trades });
    } catch(e) {
      console.log(`ERROR: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 80));
  }

  // 排序：先按成交量排（已是 top 順序），PF 太低的在後
  results.sort((a, b) => {
    const aScore = a.pf === Infinity ? 99 : a.pf;
    const bScore = b.pf === Infinity ? 99 : b.pf;
    // 成交量名次是主要排序（保持原始 top 順序），PF 只用來排同名次中的優先
    return b.volume24h - a.volume24h;
  });

  const final = results.slice(0, MAX_SYMBOLS).map(r => r.symbol);

  const output = {
    updatedAt: new Date().toISOString(),
    totalScanned: validCoins.length,
    passedPF: results.length,
    symbols: final,
    detail: results.slice(0, MAX_SYMBOLS).map(r => ({
      symbol: r.symbol,
      volume24hM: (r.volume24h / 1e6).toFixed(0) + "M",
      trades: r.trades,
      pf: r.pf === Infinity ? "∞" : r.pf.toFixed(2),
    })),
  };

  writeFileSync(WATCHLIST_DN_FILE, JSON.stringify(output, null, 2));

  console.log(`\n✅ 完成：${final.length} 幣寫入 watchlist_dn.json`);
  console.log(`   前10名：${final.slice(0, 10).join(", ")}`);
}

run().catch(e => { console.error("優化器錯誤:", e.message); process.exit(1); });
