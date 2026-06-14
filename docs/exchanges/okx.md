# OKX — API Key Setup

## What you'll get
- API Key
- Secret Key
- Passphrase (you create this yourself)

---

## Steps

1. Log into your OKX account at okx.com
2. Click your profile icon (top right) → **API** (you may need to go via **Settings** first)
3. Click **Create API Key**

### Fill in the details

- **Purpose** — select **Trading**
- **API Key Name** — something like `claude-trading`
- **Passphrase** — create one yourself. This is not your account password. Write it down immediately — you cannot recover it later.
- **Permissions:**
  - **Read** — ON ✓
  - **Trade** — ON ✓
  - **Withdrawals** — **OFF** — never turn this on
- **IP Whitelist** — ON ✓
  - Click **Add IP address**
  - Google "what is my IP address", copy it, paste it in

4. Click **Confirm** and complete your 2FA verification

### Copy your credentials

Your **API Key** and **Secret Key** are displayed on screen.

> ⚠️ The Secret Key is only shown once. Copy it immediately and save it somewhere safe.

---

## Paste into your .env

```
BITGET_API_KEY=your_api_key_here
BITGET_SECRET_KEY=your_secret_key_here
BITGET_PASSPHRASE=your_passphrase_here
```

Set `TRADE_MODE=spot` for spot trading or `TRADE_MODE=futures` for perpetuals.

---

## Notes

- OKX has a demo trading environment — useful for testing before going live
- For OKX sub-accounts, create the API key within the specific sub-account you want to trade from
