# Deploying K-BAY to the OVH VPS

K-BAY runs as its own Docker Compose project (`kbay`): its own Postgres, its own network and
volumes, and an app that listens only on `127.0.0.1:8090`. The existing Caddy is the only thing
facing the internet, so the other sites on the server are not touched.

```
internet ──443──▶ Caddy (existing) ──▶ 127.0.0.1:8090 ──▶ kbay app ──▶ kbay db (internal network only)
                                                                  └──▶ nightly backups ▶ deploy/backups/
```

## What you need on the server
- Docker with the Compose plugin (`docker compose version`)
- The existing Caddy (on the host, or in a container)
- Read access to this repository from the server (a deploy key or `gh auth login`)
- Ports 80/443 already open for Caddy; nothing else needs opening

## First deployment

```bash
sudo mkdir -p /opt/kbay && sudo chown "$USER" /opt/kbay
git clone <repo-url> /opt/kbay/src        # then: git checkout <branch with kbay/>
cd /opt/kbay/src/kbay/deploy
./deploy.sh
```

`deploy.sh` will:
1. create `deploy/.env` with random database passwords and web-push keys (mode 600),
   and set `PUBLIC_URL` to `https://<server-ip-with-dashes>.sslip.io`;
2. build the image, start `db`, `app` and `backup`, apply database migrations;
3. on the first run only, seed OPPLOX / K-BAY and print each person's **temporary password**
   (also saved to `deploy/seed-output.txt`, root-readable only — delete it after handing them out).

If port 8090 is taken by another site, set `APP_PORT` in `deploy/.env` and run `./deploy.sh` again.

## Connect Caddy (HTTPS)

The site block is in `deploy/Caddyfile.kbay`. Until the real domain is ready it uses
`<ip-with-dashes>.sslip.io`, a hostname that resolves to the server, so Caddy gets a real
Let's Encrypt certificate straight away.

**Caddy on the host (systemd):**
```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%F)
sed "s/{\$KBAY_HOST:kbay.example.sslip.io}/<ip-with-dashes>.sslip.io/; s/{\$KBAY_PORT:8090}/8090/" \
  Caddyfile.kbay | sudo tee /etc/caddy/kbay.caddy
grep -q 'import /etc/caddy/kbay.caddy' /etc/caddy/Caddyfile || echo 'import /etc/caddy/kbay.caddy' | sudo tee -a /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

**Caddy in Docker:** attach it to K-BAY's edge network and proxy to the container by name:
```bash
docker network connect kbay_edge <caddy-container>
# in the block, use:  reverse_proxy kbay-app-1:8080
# add the block to Caddy's mounted Caddyfile, then:
docker exec <caddy-container> caddy validate --config /etc/caddy/Caddyfile
docker exec <caddy-container> caddy reload --config /etc/caddy/Caddyfile
```

Check: `curl -fsS https://<host>/healthz` returns `{"ok":true}`, then sign in at `https://<host>`.

## Adding the real domain later
1. Point the domain's DNS `A` record at the server.
2. Replace the sslip.io hostname in the K-BAY Caddy block with the domain; validate and reload Caddy.
3. Set `PUBLIC_URL=https://<domain>` in `deploy/.env` and run `./deploy.sh`.

## Updates
```bash
cd /opt/kbay/src && git pull && cd kbay/deploy && ./deploy.sh
```
Migrations run automatically on start. Data stays in the `kbay_db_data` volume.

## Backups
- A dump is written at start-up and every night at 22:00 UTC (03:00 Pakistan time) to
  `deploy/backups/`, kept for 30 days (`BACKUP_KEEP_DAYS`).
- Copy them off the server too (e.g. a nightly `rclone`/`scp` to another machine or bucket) —
  a backup on the same disk does not survive losing the server.
- Restore: `./restore.sh backups/kbay-YYYYMMDD-HHMMSS.sql.gz` (asks for confirmation; replaces data).

## Useful commands
```bash
docker compose ps                       # status
docker compose logs -f app              # app logs
docker compose exec db psql -U kbay_owner kbay   # database shell
docker compose down                     # stop (data kept)
```

---

## Brief for Claude Code on the VPS

Paste this to the Claude Code session running on the VPS:

> Deploy K-BAY from this repository following `kbay/deploy/VPS_DEPLOY.md`. This server hosts
> other sites behind Caddy: do not change, restart or remove anything that belongs to them.
> 1. Check Docker + Compose are installed and find how Caddy runs (systemd on the host, or a
>    container) and where its Caddyfile is. Show me what you found before changing anything.
> 2. Clone/pull the repo into `/opt/kbay/src`, check out the branch that contains `kbay/`, and run
>    `kbay/deploy/deploy.sh`. If port 8090 is in use, pick a free port via `APP_PORT` in `.env`.
> 3. Save the temporary passwords it prints to tell me, then delete `deploy/seed-output.txt`.
> 4. Add the K-BAY site block to Caddy using the sslip.io hostname for this server's public IP,
>    back up the Caddyfile first, run `caddy validate`, and only then reload Caddy (reload, not restart).
> 5. Verify `https://<host>/healthz`, that the other sites still respond as before, and that port
>    8090 is not reachable from outside (`ss -ltnp | grep 8090` shows 127.0.0.1 only).
> 6. Report the public URL, the Caddy changes you made (with the backup path), and the
>    `docker compose ps` output.
