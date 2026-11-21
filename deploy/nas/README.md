# The website on the NAS (service.neotokyo.in)

The same pattern as the planner: the site runs on the NAS, and the Cloudflare
tunnel the NAS already runs for the developers' neotokyo.in zone publishes it.
The NAS keeps itself up to date from GitHub `main`, so merging is publishing.

```
customer ─https─▶ Cloudflare (service.neotokyo.in) ─tunnel─▶ cloudflared on the NAS ─▶ 127.0.0.1:8097 (server.js) ─▶ ./site
GitHub main (dashboard/) ─every 5 min─▶ update.sh ─▶ ./site
```

| | |
|---|---|
| Folder on the NAS | `/home/neo_tokyo/neo-tracker/` (`server.js`, `update.sh`, `site/`, `repo/`) |
| Web server | systemd `neo-tracker` (starts at boot, restarts on failure) |
| Updates | systemd `neo-tracker-update.timer` (every 5 minutes, from GitHub `main`) |
| Port | `127.0.0.1:8097` (loopback only; 8090 is the planner, 8095 the configurator test) |
| Public address | `https://service.neotokyo.in` (route added by the developers in Cloudflare) |

The repository is public, so the NAS needs no GitHub login to update.

## 1. Install on the NAS (once)

From the PC, build the folder and copy it (`deploy\nas\make-package.ps1` writes
it to `A:\Projects\Service Website\nas-tracker`):

```
powershell -ExecutionPolicy Bypass -File deploy\nas\make-package.ps1
scp -r "A:\Projects\Service Website\nas-tracker" nas:~/neo-tracker
```

On the NAS (`ssh nas`):

```
chmod +x ~/neo-tracker/update.sh
sudo cp ~/neo-tracker/neo-tracker.service ~/neo-tracker/neo-tracker-update.service ~/neo-tracker/neo-tracker-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now neo-tracker
sudo systemctl enable --now neo-tracker-update.timer
sudo systemctl start neo-tracker-update      # first update now: clones main into ~/neo-tracker/repo
curl -s http://127.0.0.1:8097/ping.json      # {"site":"neo-service"}
cat ~/neo-tracker/site/VERSION.txt           # tracker <commit> <time>
```

## 2. The route (the developers' Cloudflare account, which holds neotokyo.in)

Zero Trust → Networks → Tunnels → the tunnel the NAS connector runs (the one
whose public hostnames already include the planner and the configurator test)
→ Public hostname → Add a public hostname:

| Field | Value |
|---|---|
| Subdomain | `service` |
| Domain | `neotokyo.in` |
| Path | (empty) |
| Service type | **HTTP** (not HTTPS) |
| URL | `localhost:8097` |

Save. Cloudflare creates the `service` DNS record (a proxied CNAME to the
tunnel) itself. If a `service` record already exists in DNS, delete it first,
or the hostname can't be added. Nothing else: no Access policy (customers use
it), no token change (the NAS connector already runs this tunnel).

Check from anywhere:

```
curl -s https://service.neotokyo.in/ping.json     # {"site":"neo-service"}
```

## 3. What happens by itself after that

- Neo Service PCs see `ping.json` at their next start or within the hour, and
  switch every tracking link, WhatsApp message and printed QR code to
  `https://service.neotokyo.in/t/<code>`. Build links, WhatsApp and Customer
  view on builds appear then.
- The staff portal is at `https://service.neotokyo.in/staff/`.
- Every merge to GitHub `main` reaches the NAS within about 5 minutes.

## Check or stop

```
systemctl status neo-tracker neo-tracker-update.timer
journalctl -u neo-tracker -u neo-tracker-update -n 50
sudo systemctl start neo-tracker-update                    # update now
sudo systemctl disable --now neo-tracker-update.timer      # stop updating
sudo systemctl disable --now neo-tracker                   # stop the site
```

To go back one version by hand: `mv ~/neo-tracker/site ~/neo-tracker/site.bad && mv ~/neo-tracker/site.old ~/neo-tracker/site`
(and stop the timer until `main` is fixed).
