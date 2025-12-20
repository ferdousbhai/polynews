# PolyNews Setup Checklist

## Cloudflare R2 Setup

- [ ] Enable R2 in Cloudflare Dashboard (R2 → Get Started)
- [ ] Create bucket: `pnpm exec wrangler r2 bucket create polynews`
- [ ] Enable public access: Dashboard → R2 → polynews → Settings → Public Access → Allow
- [ ] Copy public URL (e.g., `https://pub-xxx.r2.dev`)

## R2 API Token

- [ ] Dashboard → R2 → Manage R2 API Tokens → Create API Token
  - Permission: Object Read & Write
  - Bucket: polynews
- [ ] Save Access Key ID and Secret Access Key

## GitHub Secrets

Add to: Repo → Settings → Secrets → Actions

- [ ] `CLOUDFLARE_ACCOUNT_ID` = `0af9e0921b880657d84a6c07307f8aef`
- [ ] `R2_ACCESS_KEY_ID` = (from R2 token)
- [ ] `R2_SECRET_ACCESS_KEY` = (from R2 token)
- [ ] `GOOGLE_API_KEY` = (already exists)

## Cloudflare Pages Environment

Dashboard → Pages → polynews → Settings → Environment Variables

- [ ] `R2_PUBLIC_URL` = (your R2 public URL)

## Optional

- [ ] Connect Git for auto-deploy: Pages → polynews → Settings → Builds → Connect Git

## Test

- [ ] Trigger GitHub Action manually to populate R2
- [ ] Verify site loads fresh data from R2

## Move Domain to Cloudflare

- [ ] Add domain: Dashboard → Add a site → `polynews.media` → Free plan
- [ ] Copy the 2 Cloudflare nameservers (e.g., `ada.ns.cloudflare.com`)
- [ ] Update nameservers at Gandi:
  - Gandi Dashboard → polynews.media → Nameservers
  - Replace `ns-138-a.gandi.net`, `ns-77-c.gandi.net`, `ns-103-b.gandi.net`
  - With Cloudflare nameservers from above
- [ ] Wait for propagation (10 min - 24 hours)
- [ ] Connect to Pages: Pages → polynews → Custom domains → Add `polynews.media`
- [ ] Verify SSL is active
