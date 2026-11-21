# Customer tracker on the NAS (service.neotokyo.in)

The same pattern as the planner: the site runs on the NAS, and the Cloudflare
tunnel the NAS already runs for the developers' neotokyo.in zone publishes it.

```
customer ─https─▶ Cloudflare (service.neotokyo.in) ─tunnel─▶ cloudflared on the NAS ─▶ 127.0.0.1:8097 (server.js) ─▶ ./site
```

| | |
|---|---|
| Folder on the NAS | `/home/neo_tokyo/neo-tracker/` (`server.js`, `neo-tracker.service`, `site/`) |
| Service | `neo-tracker` (systemd, starts at boot, restarts on failure) |
| Port | `127.0.0.1:8097` (loopback only; 8090 is the planner, 8095 the configurator test) |
| Public address | `https://service.neotokyo.in` (route added by the developers in Cloudflare) |

## The route (for the developers' Cloudflare account)

Zero Trust → Networks → Tunnels → the tunnel the NAS connector runs (the one
with the planner and configurator-test routes) → Public hostnames → Add:

- Subdomain `service`, domain `neotokyo.in`, path empty
- Service type **HTTP** (not HTTPS), URL `localhost:8097`

Cloudflare creates the DNS record itself. No token or password changes: the NAS
connector already runs this tunnel.

## Install (once)

From the PC, with the package folder built by `make-package.ps1`:

```
scp -r "A:\Projects\Service Website\nas-tracker" nas:~/neo-tracker
```

On the NAS (`ssh nas`):

```
sudo cp ~/neo-tracker/neo-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now neo-tracker
curl -sI http://127.0.0.1:8097/ | head -1        # HTTP/1.1 200 OK
```

Once the route is added, `https://service.neotokyo.in/ping.json` answers
`{"site":"neo-service"}`. Neo Service checks it at start and every hour; the first
good answer switches its tracking links and QR codes to service.neotokyo.in.

## Update the site

Copy the new files over `~/neo-tracker/site/`. No restart needed: the server
reads from disk. Restart only after changing `server.js`:
`sudo systemctl restart neo-tracker`.

## Check or stop

```
systemctl status neo-tracker
journalctl -u neo-tracker -n 50
sudo systemctl disable --now neo-tracker
```
