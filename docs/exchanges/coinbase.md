# Coinbase Advanced — API Key Setup

> This guide is for **Coinbase Advanced** (previously Coinbase Pro). The standard Coinbase app does not support API trading.

## What you'll get
- API Key
- Private Key (this is your secret — save the whole thing)
- No passphrase

---

## Steps

1. Log into Coinbase Advanced at advanced.coinbase.com
2. Click your profile icon (top right) → **Settings**
3. Click **API** in the left menu
4. Click **New API Key**

### Fill in the details

- **Nickname** — something like `claude-trading`
- **Portfolios** — select the portfolio you want to trade from (usually Default)
- **Permissions:**
  - **View** — ON ✓
  - **Trade** — ON ✓
  - **Transfer** — **OFF** — this covers withdrawals, never turn it on
- **IP Allowlist** — ON ✓
  - Click **Add IP**
  - Google "what is my IP address", copy it, paste it in

5. Click **Create & Download**

### Save your credentials

Coinbase gives you a `.json` file download. Open it — you'll find:
- `"name"` — this is your API Key
- `"privateKey"` — this is your Secret Key (it's a long string starting with `-----BEGIN EC PRIVATE KEY-----`)

> ⚠️ This file is only available at creation. If you lose it, you must delete and recreate the key.

---

## Paste into your .env

```
BITGET_API_KEY=your_api_name_here
BITGET_SECRET_KEY=your_private_key_here
BITGET_PASSPHRASE=
```

Paste the full private key including the `-----BEGIN EC PRIVATE KEY-----` and `-----END EC PRIVATE KEY-----` lines.

Leave `BITGET_PASSPHRASE` blank.

Set `TRADE_MODE=spot`.

---

## Notes

- Coinbase Advanced uses EC (elliptic curve) private keys — they look different from other exchanges but work the same way
- Coinbase is US-focused — availability varies by country
