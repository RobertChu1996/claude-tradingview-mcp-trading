# KuCoin — API Key Setup

## What you'll get
- API Key
- Secret Key
- Passphrase (you create this yourself)

---

## Steps

1. Log into your KuCoin account at kucoin.com
2. Click your profile icon (top right) → **API Management**
3. Click **Create API**

### Fill in the details

- **API Name** — something like `claude-trading`
- **API Passphrase** — create one yourself. This is not your account password. Write it down immediately — you cannot see it again after leaving this screen.
- **Permissions:**
  - **General** — ON ✓
  - **Trade** — ON ✓
  - **Futures** — ON ✓ (only if you're trading futures)
  - **Transfer** — **OFF**
  - **Withdrawal** — **OFF** — never turn this on
- **IP Whitelist** — ON ✓
  - Click **Add**
  - Google "what is my IP address", copy it, paste it in

4. Click **Next** and complete your 2FA verification

### Copy your credentials

Your **API Key** and **Secret** appear on screen.

> ⚠️ The Secret is only shown once. Copy it immediately and save it somewhere safe.

---

## Paste into your .env

```
BITGET_API_KEY=your_api_key_here
BITGET_SECRET_KEY=your_secret_here
BITGET_PASSPHRASE=your_passphrase_here
```

Set `TRADE_MODE=spot` for spot trading or `TRADE_MODE=futures` for futures/perps.

---

## Notes

- KuCoin has both spot and futures accounts — make sure you're creating the API key in the right account context
- KuCoin futures uses a separate sub-account — if you want to trade futures, you may need to create the API key from within the futures section
