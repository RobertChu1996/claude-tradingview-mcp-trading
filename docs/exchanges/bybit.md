# Bybit — API Key Setup

## What you'll get
- API Key
- Secret Key
- No passphrase (Bybit doesn't use one)

---

## Steps

1. Log into your Bybit account at bybit.com
2. Click your profile icon (top right) → **Account & Security**
3. Scroll down to **API Management** → click **Create New Key**

### Choose key type

Select **System-generated API Keys**

### Fill in the details

- **Key Name** — something like `claude-trading`
- **Key Permissions:**
  - **Read-Write** — select this
- **Under Read-Write permissions, enable:**
  - **Spot Trading** — ON ✓ (or Contract Trading for futures/perps)
  - **Withdrawals** — **OFF** — never turn this on
  - **Transfer** — OFF
- **IP Restriction** — ON ✓
  - Click **Add** next to IP restriction
  - Google "what is my IP address", copy it, paste it in

4. Click **Submit** and complete your 2FA verification

### Copy your credentials

Your **API Key** and **Secret Key** appear on the confirmation screen.

> ⚠️ The Secret Key is only shown once. Copy it immediately and save it somewhere safe.

---

## Paste into your .env

```
BITGET_API_KEY=your_api_key_here
BITGET_SECRET_KEY=your_secret_key_here
BITGET_PASSPHRASE=
```

Leave `BITGET_PASSPHRASE` blank — Bybit doesn't use one.

Set `TRADE_MODE=spot` for spot trading or `TRADE_MODE=futures` for perpetuals.

---

## Notes

- Bybit API keys expire after 90 days without use — the platform will email you a warning
- For Unified Trading Account (UTA), make sure you enable the correct sub-account permissions
