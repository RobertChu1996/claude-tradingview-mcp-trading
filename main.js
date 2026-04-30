/**
 * Railway entry point:
 * - Starts HTTP data server (always on, serves /data/ files)
 * - Runs all 4 strategies every 15 minutes (replaces Railway cronSchedule)
 */
import "./data_server.js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { LAST_RUN_FILE } from "./paths.js";

// 用 spawn 非同步跑單一 bot，回傳 Promise
function spawnBot(label, script) {
  return new Promise((resolve) => {
    console.log(`\n  ${label}`);
    const child = spawn("node", [script], { stdio: "inherit" });
    child.on("close", (code) => {
      if (code !== 0) console.error(`  ⚠️ ${script} 結束碼 ${code}`);
      resolve();
    });
    child.on("error", (e) => { console.error(`  ❌ ${script}: ${e.message}`); resolve(); });
  });
}

async function runBot() {
  console.log(`\n${"━".repeat(57)}`);
  console.log(`  [main] 觸發四策略掃描 ${new Date().toISOString()}`);
  console.log(`${"━".repeat(57)}`);

  // 週優化
  const needsOptimize = !existsSync(LAST_RUN_FILE) ||
    (Date.now() - new Date(readFileSync(LAST_RUN_FILE, "utf8").trim()).getTime()) / 86400000 >= 7;
  if (needsOptimize) {
    writeFileSync(LAST_RUN_FILE, new Date().toISOString());
    console.log("\n[Auto-Optimize] 週優化背景啟動...");
    spawn("node", ["optimize_all.js"], { detached: true, stdio: "ignore" }).unref();
  }

  // 四策略依序執行（策略 D ORB 已停用：回測 PF 0.94 負期望值）
  await spawnBot("策略 A：VWAP + RSI(3) + EMA(8)  [1H]", "bot.js");
  await spawnBot("策略 C：BB Breakout + ATR Stop   [1H]", "bot_bb.js");
  await spawnBot("策略 E：EMA Trend Pullback        [1H]", "bot_e.js");
  await spawnBot("策略 K：Keltner Channel Breakout  [1H]", "bot_k.js");

  console.log("\n✅ 四策略掃描完成\n");
}

// 立即跑一次，之後每 15 分鐘
runBot();
setInterval(runBot, 15 * 60 * 1000);
