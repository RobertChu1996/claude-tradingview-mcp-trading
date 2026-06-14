/**
 * tv_mark_trade.js
 * 在 TradingView 上標記進場位置、止損、止盈
 * 用法: node tv_mark_trade.js <symbol> <side> <entry> <sl> <tp>
 *
 * 透過 CDP (localhost:9222) 直接呼叫 TradingView 圖表 API
 * Railway 上 CDP 不存在時靜默跳過，不影響交易執行
 */

const [,, symbol, side, entryStr, slStr, tpStr] = process.argv;

const entry  = parseFloat(entryStr);
const sl     = parseFloat(slStr);
const tp     = parseFloat(tpStr);

if (!symbol || !side || isNaN(entry) || isNaN(sl) || isNaN(tp)) {
  console.error("用法: node tv_mark_trade.js <symbol> <side> <entry> <sl> <tp>");
  process.exit(1);
}

const CDP_URL = "http://localhost:9222";
const TIMEOUT  = 3000;

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 用 WebSocket 送 CDP 命令
async function cdpEvaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const timeout = setTimeout(() => { ws.close(); reject(new Error("CDP timeout")); }, TIMEOUT);

    ws.onopen = () => {
      ws.send(JSON.stringify({ id: id++, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id) {
        clearTimeout(timeout);
        ws.close();
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result?.result?.value);
      }
    };
    ws.onerror = (e) => { clearTimeout(timeout); reject(new Error("WebSocket error")); };
  });
}

async function drawLine(wsUrl, price, color, label, lineWidth = 1) {
  const now = Math.floor(Date.now() / 1000);
  const overrides = JSON.stringify({
    linecolor:   color,
    linewidth:   lineWidth,
    linestyle:   0,
    showLabel:   true,
    textcolor:   color,
    fontsize:    12,
    horzLabelsAlign: "right",
    vertLabelsAlign: "middle",
  });
  const expr = `
    (function() {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      return api.createShape(
        { time: ${now}, price: ${price} },
        { shape: "horizontal_line", overrides: ${overrides}, text: ${JSON.stringify(label)} }
      );
    })()
  `;
  return cdpEvaluate(wsUrl, expr);
}

async function setSymbol(wsUrl, sym) {
  // OKX 格式 BTCUSDT → TradingView OKX:BTCUSDT.P (perp) or BINANCE:BTCUSDT
  const tvSym = `OKX:${sym.replace("USDT", "USDT.P")}`;
  const expr = `
    (function() {
      var api = window.TradingViewApi._activeChartWidgetWV.value();
      api.setSymbol(${JSON.stringify(tvSym)}, function() {});
      return true;
    })()
  `;
  await cdpEvaluate(wsUrl, expr);
  // 等待圖表切換
  await new Promise(r => setTimeout(r, 1500));
}

async function main() {
  // 1. 確認 TradingView CDP 在線
  let targets;
  try {
    targets = await fetchWithTimeout(`${CDP_URL}/json/list`);
  } catch {
    // Railway 或本地 TradingView 未開，靜默跳過
    process.exit(0);
  }

  const target = targets.find(t => t.type === "page" && /tradingview\.com\/chart/i.test(t.url))
               || targets.find(t => t.type === "page" && /tradingview/i.test(t.url));

  if (!target?.webSocketDebuggerUrl) {
    process.exit(0);  // TradingView 未開
  }

  const wsUrl = target.webSocketDebuggerUrl;
  const isLong = side === "long";

  try {
    // 2. 切換到對應幣種
    await setSymbol(wsUrl, symbol);

    // 3. 畫三條水平線
    const entryColor = "#FFFFFF";
    const tpColor    = isLong ? "#26a69a" : "#ef5350";  // 綠/紅
    const slColor    = isLong ? "#ef5350" : "#26a69a";

    const direction  = isLong ? "LONG" : "SHORT";
    const rr = Math.abs(tp - entry) / Math.abs(entry - sl);

    await drawLine(wsUrl, entry, entryColor, `${direction} ${symbol} 進場 $${entry}`, 2);
    await drawLine(wsUrl, tp,    tpColor,    `止盈 $${tp.toFixed(6)} (R:R ${rr.toFixed(1)})`);
    await drawLine(wsUrl, sl,    slColor,    `止損 $${sl.toFixed(6)}`);

    console.log(`✅ TradingView 標記完成 — ${direction} ${symbol} 進場$${entry} 止損$${sl} 止盈$${tp}`);
  } catch (e) {
    // 畫線失敗不影響交易
    console.log(`⚠️  TradingView 標記失敗 (非致命): ${e.message}`);
  }
}

main().catch(() => process.exit(0));
