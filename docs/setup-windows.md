# Windows Setup Guide

Everything in the main README applies — the only differences are how you launch TradingView with CDP enabled and where the files live.

---

## 1. Find your TradingView executable

TradingView Desktop on Windows is installed as an `.msix` package. The executable is NOT in `Program Files` — it lives in a path like:

```
C:\Users\[YourName]\AppData\Local\Packages\TradingView.TradingViewDesktop_[hash]\LocalCache\Local\TradingView\TradingView.exe
```

To find the exact path:
1. Open PowerShell
2. Run:
```powershell
Get-AppxPackage -Name "TradingView*" | Select-Object -ExpandProperty InstallLocation
```
3. Inside that folder, look for `TradingView.exe`

---

## 2. Launch TradingView with CDP enabled

You need to launch TradingView with the `--remote-debugging-port=9222` flag so the MCP can connect.

Close TradingView if it's running, then in PowerShell:

```powershell
& "C:\Users\[YourName]\AppData\Local\Packages\TradingView.TradingViewDesktop_[hash]\LocalCache\Local\TradingView\TradingView.exe" --remote-debugging-port=9222
```

Replace the path with the one you found in Step 1.

**Tip:** Save this as a `.ps1` script or a desktop shortcut so you don't have to type it every time.

---

## 3. Configure the MCP

In your Claude Code MCP config (`%APPDATA%\Claude\claude_desktop_config.json`), make sure the TradingView MCP is pointing to the right port:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "npx",
      "args": ["-y", "@tradingview/mcp-server"],
      "env": {
        "CDP_PORT": "9222"
      }
    }
  }
}
```

---

## 4. Verify the connection

In Claude Code terminal:

```
tv_health_check
```

If it returns `cdp_connected: true` — you're good. If not:
- Make sure TradingView was launched with the `--remote-debugging-port=9222` flag (not opened normally)
- Check that nothing else is using port 9222
- Try closing and relaunching TradingView using the PowerShell command above

---

## 5. Continue with the main setup

Once `tv_health_check` passes, go back to the [main README](../README.md) and continue from Step 2.
