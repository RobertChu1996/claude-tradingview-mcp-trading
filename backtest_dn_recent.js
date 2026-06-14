/**
 * DN 策略近期 backtest（2026-05-13 至今）
 * 完全對齊 bot_donchian.js 參數：4H bars, N_HIGH=180, N_LOW=90, TP_RATIO=3.0
 * 資料來源：OKX
 */

const N_HIGH   = 180;   // 4H × 180 = 30天
const N_LOW    = 90;    // 4H × 90 = 15天
const TP_RATIO = 3.0;
const BTC_MA   = 1200;  // 4H × 1200 = 200日
const MAX_OPEN = 8;
const RISK_USD = 10;    // 每筆風險$10 (1% of $1000)

const START_DATE = new Date("2026-05-13T00:00:00Z").getTime();

function toOkxInstId(sym) {
  for (const q of ["USDT","USDC","BTC","ETH"])
    if (sym.endsWith(q)) return `${sym.slice(0,-q.length)}-${q}`;
  return sym;
}

async function fetchOkx4H(symbol, limit) {
  const instId = toOkxInstId(symbol);
  const rows = [];
  const r1 = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=4H&limit=300`);
  const d1 = await r1.json();
  rows.push(...(d1.data || []));
  if (limit > 300 && rows.length > 0) {
    const oldest = rows[rows.length-1][0];
    const r2 = await fetch(`https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=4H&limit=300&after=${oldest}`);
    const d2 = await r2.json();
    rows.push(...(d2.data || []));
    if (rows.length < limit) {
      const oldest2 = rows[rows.length-1][0];
      const r3 = await fetch(`https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=4H&limit=300&after=${oldest2}`);
      const d3 = await r3.json();
      rows.push(...(d3.data || []));
    }
  }
  if (!rows.length) throw new Error(`no data: ${symbol}`);
  return rows.reverse().map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4] }));
}

function rollingHigh(arr, n) { return Math.max(...arr.slice(-n).map(c=>c.high)); }
function rollingLow(arr, n)  { return Math.min(...arr.slice(-n).map(c=>c.low));  }
function sma(arr, n) { const s=arr.slice(-n); return s.reduce((a,b)=>a+b,0)/s.length; }

async function backtest(symbol) {
  const candles = await fetchOkx4H(symbol, BTC_MA + N_HIGH + N_LOW + 300);
  if (candles.length < BTC_MA + N_HIGH + N_LOW) return [];

  const trades = [];
  let openPos = null;

  for (let i = BTC_MA + N_HIGH; i < candles.length; i++) {
    const bar = candles[i];

    // BTC filter（只用於 BTCUSDT 自身建牛熊判斷）
    const btcBull = symbol === "BTCUSDT"
      ? bar.close >= sma(candles.slice(i-BTC_MA, i).map(c=>c.close), BTC_MA)
      : null; // 其他幣稍後用 btcBullAtBar map

    const isSimPeriod = bar.time >= START_DATE;

    // 管理現有倉位
    if (openPos) {
      const isShort = openPos.side === "short";
      // 追蹤止損
      const newSL = isShort
        ? rollingHigh(candles.slice(i-N_LOW, i), N_LOW)
        : rollingLow(candles.slice(i-N_LOW, i), N_LOW);
      if (isShort ? newSL < openPos.sl : newSL > openPos.sl) openPos.sl = newSL;

      const slHit = isShort ? bar.high >= openPos.sl : bar.low  <= openPos.sl;
      const tpHit = isShort ? bar.low  <= openPos.tp : bar.high >= openPos.tp;

      if (slHit || tpHit) {
        const isUpBar = bar.close > bar.open;
        let reason, exitPx;
        if (slHit && tpHit) {
          const tpFirst = isShort ? !isUpBar : isUpBar;
          reason = tpFirst ? "TP" : "SL";
          exitPx = tpFirst ? openPos.tp : openPos.sl;
        } else if (tpHit) { reason="TP"; exitPx=openPos.tp; }
        else               { reason="SL"; exitPx=openPos.sl; }

        const sign = isShort ? -1 : 1;
        const pnl  = sign * (exitPx - openPos.entry) * openPos.qty;
        trades.push({ ...openPos, exitBar: bar.time, exitPx, reason, pnl, status:"closed" });
        openPos = null;
      }
    }

    // 進場掃描（只在模擬期間）
    if (!isSimPeriod || openPos) continue;

    const prev = candles.slice(i-N_HIGH, i);
    const win  = candles.slice(i-N_LOW, i+1);

    // 做空：收盤突破前 N_HIGH 低點
    const prevLow = rollingLow(prev, N_HIGH);
    if (bar.close < prevLow) {
      const sl    = rollingHigh(win, N_LOW);
      const slPct = (sl - bar.close) / bar.close;
      if (sl > bar.close && slPct >= 0.003 && slPct <= 0.25) {
        const tp  = bar.close - (sl - bar.close) * TP_RATIO;
        if (tp > 0) {
          const qty = RISK_USD / slPct / bar.close;
          openPos = { symbol, side:"short", entry:bar.close, sl, tp, qty, entryBar:bar.time };
        }
      }
    }

    // 做多：收盤突破前 N_HIGH 高點
    const prevHigh = rollingHigh(prev, N_HIGH);
    if (!openPos && bar.close > prevHigh) {
      const sl    = rollingLow(win, N_LOW);
      const slPct = (bar.close - sl) / bar.close;
      if (sl < bar.close && slPct >= 0.003 && slPct <= 0.25) {
        const tp  = bar.close + (bar.close - sl) * TP_RATIO;
        const qty = RISK_USD / slPct / bar.close;
        openPos = { symbol, side:"long", entry:bar.close, sl, tp, qty, entryBar:bar.time };
      }
    }
  }

  // 還在持倉的當未實現
  if (openPos) {
    const last = candles[candles.length-1];
    const sign = openPos.side === "short" ? -1 : 1;
    const uPnl = sign * (last.close - openPos.entry) * openPos.qty;
    trades.push({ ...openPos, exitBar:null, exitPx:last.close, reason:"OPEN", pnl:uPnl, status:"open" });
  }

  return trades;
}

// 用 optimize 後的 64 幣清單（前30名代表性）
const SYMBOLS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT",
  "ADAUSDT","AVAXUSDT","BNBUSDT","LINKUSDT","DOTUSDT",
  "NEARUSDT","LTCUSDT","UNIUSDT","AAVEUSDT","ATOMUSDT",
  "INJUSDT","APTUSDT","ARBUSDT","OPUSDT","SUIUSDT",
  "SHIBUSDT","BCHUSDT","TRXUSDT","ICPUSDT","FILUSDT",
  "HBARUSDT","ETCUSDT","XLMUSDT","PENDLEUSDT","TIAUSDT",
];

async function main() {
  console.log(`=== DN 策略 Backtest（${new Date(START_DATE).toISOString().slice(0,10)} ~ 今天）===`);
  console.log(`參數：4H bars, N_HIGH=${N_HIGH}, N_LOW=${N_LOW}, TP_RATIO=${TP_RATIO}\n`);

  const allTrades = [];
  for (const sym of SYMBOLS) {
    process.stdout.write(`  掃描 ${sym.padEnd(14)}`);
    try {
      const trades = await backtest(sym);
      const sig = trades.filter(t => t.entryBar >= START_DATE);
      if (sig.length) {
        process.stdout.write(`→ ${sig.length} 筆\n`);
        allTrades.push(...sig);
      } else {
        process.stdout.write(`→ 無訊號\n`);
      }
    } catch(e) { process.stdout.write(`→ ERR: ${e.message}\n`); }
    await new Promise(r => setTimeout(r, 100));
  }

  const closed = allTrades.filter(t => t.status==="closed");
  const open   = allTrades.filter(t => t.status==="open");
  const wins   = closed.filter(t => t.pnl > 0);
  const totalPnl = allTrades.reduce((s,t)=>s+t.pnl,0);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`訊號總數：${allTrades.length} 筆（已平：${closed.length}，持倉：${open.length}）`);
  if (closed.length) console.log(`勝率：${(wins.length/closed.length*100).toFixed(1)}%（${wins.length}勝/${closed.length-wins.length}負）`);
  console.log(`總 PnL（含未實現）：$${totalPnl.toFixed(2)}`);

  if (allTrades.length) {
    console.log(`\n── 明細 ──`);
    for (const t of allTrades.sort((a,b)=>a.entryBar-b.entryBar)) {
      const entry = new Date(t.entryBar).toISOString().slice(0,16);
      const exit  = t.exitBar ? new Date(t.exitBar).toISOString().slice(0,16) : "持倉中";
      const pnlStr = (t.pnl>=0?"+":"")+t.pnl.toFixed(2);
      console.log(`${t.symbol.padEnd(14)} ${t.side.padEnd(6)} 進:${entry} 出:${exit} ${t.reason.padEnd(4)} PnL:${pnlStr}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
