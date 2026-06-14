# Binance — API Key Setup

## What you'll get
- API Key
- Secret Key
- No passphrase (Binance doesn't use one)

---

## Steps

1. Log into your Binance account at binance.com
2. Click your profile icon (top right) → **API Management**
3. Click **Create API**
4. Choose **System generated** → click **Next**
5. Give your key a label — something like `claude-trading`
6. Complete the security verification (email code + 2FA)

### Set your permissions

On the permissions screen:

- **Enable Reading** — ON ✓
- **Enable Spot & Margin Trading** — ON ✓ (or Futures Trading if using futures)
- **Enable Withdrawals** — **OFF** — never turn this on
- **Restrict access to trusted IPs only** — ON ✓
  - Click **Add IP**
  - Google "what is my IP address", copy it, paste it in
  - Click **Confirm**

7. Click **Save**
8. Complete the security verification again

### Copy your credentials

You'll see your **API Key** and **Secret Key** on screen.

> ⚠️ The Secret Key is only shown once. Copy it immediately and save it somewhere safe. If you lose it, you'll need to delete this key and create a new one.

---

## Paste into your .env

```
BITGET_API_KEY=your_api_key_here
BITGET_SECRET_KEY=your_secret_key_here
BITGET_PASSPHRASE=
```

Leave `BITGET_PASSPHRASE` blank — Binance doesn't use one.

Set `TRADE_MODE=spot` for spot trading or `TRADE_MODE=futures` for futures.

---

## Notes

- Binance API keys expire after 90 days of inactivity — log in occasionally or the key will deactivate
- If you're using Binance US, the process is the same but at binance.us
