/**
 * Railway entry point:
 * - Starts HTTP data server (always on, serves /data/ files)
 * - Runs DN Donchian strategy every 15 minutes
 */
import "./data_server.js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { LAST_RUN_DN_FILE } from "./paths.js";

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
  console.log(`  [main] DN 掃描 ${new Date().toISOString()}`);
  console.log(`${"━".repeat(57)}`);

  // DN 幣種清單週優化
  const needsDnOptimize = !existsSync(LAST_RUN_DN_FILE) ||
    (Date.now() - new Date(readFileSync(LAST_RUN_DN_FILE, "utf8").trim()).getTime()) / 86400000 >= 7;
  if (needsDnOptimize) {
    writeFileSync(LAST_RUN_DN_FILE, new Date().toISOString());
    console.log("[Auto-Optimize] DN 幣種清單優化背景啟動...");
    spawn("node", ["optimize_dn.js"], { detached: true, stdio: "ignore" }).unref();
  }

  await spawnBot("策略 DN：Donchian Breakout [4H]", "bot_donchian.js");

  console.log("\n✅ 掃描完成\n");
}

runBot();
setInterval(runBot, 15 * 60 * 1000);
