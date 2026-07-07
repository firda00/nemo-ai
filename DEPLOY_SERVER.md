# Nemo AI — deploy to your own Ubuntu/Debian server with a free DuckDNS domain

Your site is a **static frontend** (Vite/React). The backend (Supabase) is already
in the cloud, so "installing on the server" just means: build `dist/`, serve it over
HTTPS, and point a free domain at the server. ~20 minutes.

Replace `nemoai.duckdns.org` and `SERVER_IP` everywhere with your real values.

---

## 1. Free subdomain (DuckDNS) — 5 min

1. Open **https://www.duckdns.org** → sign in (Google/GitHub).
2. In the box, type a name, e.g. `nemoai`, click **add domain** → you now own
   `nemoai.duckdns.org`.
3. In the **current ip** field put your server's public IP and click **update ip**
   (find the IP on the server with:  `curl -4 ifconfig.me`).

That's it — `nemoai.duckdns.org` now points to your server.

---

## 2. Open ports 80 and 443 on the server

```bash
sudo ufw allow 80
sudo ufw allow 443
```
> If your provider (AWS/GCP/Oracle/etc.) has its own firewall / "security group",
> open TCP 80 and 443 there too — otherwise HTTPS setup will fail.

---

## 3. Build the site (on your Windows PC, where .env.local exists)

The Supabase URL + public key are baked into the build from `.env.local`, so build
locally and upload the result:

```powershell
cd C:\Users\firda\nemo-ai
npm run build          # produces the dist\ folder
```

Upload `dist\` to the server (scp comes with Windows 10/11; or use WinSCP GUI):

```powershell
ssh USER@SERVER_IP "sudo mkdir -p /var/www/nemo && sudo chown -R $USER /var/www/nemo"
scp -r dist\* USER@SERVER_IP:/var/www/nemo/
```
(Replace `USER` with your server login, e.g. `root` or `ubuntu`.)

---

## 4. Install Caddy (gives automatic free HTTPS)

On the server:

```bash
sudo apt update
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Put your domain in the Caddy config:

```bash
sudo nano /etc/caddy/Caddyfile
```
Paste this (change the domain), save (Ctrl+O, Enter, Ctrl+X):

```
nemoai.duckdns.org {
    root * /var/www/nemo
    encode zstd gzip
    try_files {path} /index.html
    file_server
}
```
(There is a ready copy of this in the repo: `Caddyfile`.)

Restart Caddy — it fetches a Let's Encrypt certificate automatically:

```bash
sudo systemctl restart caddy
sudo systemctl status caddy --no-pager
```

---

## 5. Open it

Go to **https://nemoai.duckdns.org** — the site loads with a valid HTTPS lock.
(First load may take ~30s while the certificate is issued.)

---

## 6. IMPORTANT — point auth at the new domain

Login/OAuth need the domain registered on the backend:

- **Supabase Auth** → tell the assistant your exact subdomain and it can set
  `site_url` + redirect allow-list via the Management API. (Or do it in the Supabase
  dashboard → Authentication → URL Configuration: Site URL = `https://nemoai.duckdns.org`,
  add `https://nemoai.duckdns.org/**` to Redirect URLs.)
- **Google login** (if used) → Google Cloud Console → your OAuth client → add
  `https://nemoai.duckdns.org` to Authorized JavaScript origins and
  `https://ogfmyjiuqmgroobckdyw.supabase.co/auth/v1/callback` is already the redirect.
- **Stripe** — no change (success/cancel URLs use the current origin automatically).

---

## Updating the site later

Rebuild locally and re-upload:
```powershell
npm run build
scp -r dist\* USER@SERVER_IP:/var/www/nemo/
```
No Caddy restart needed — it serves the new files immediately.

---

## Note on the Edge Functions

The 404s you saw for `backend-status` / `ops-workflow` are a **separate** thing —
those live on Supabase, not your server. Run `deploy.ps1` to deploy them. Serving the
frontend on your domain does not deploy or change the Supabase functions.
