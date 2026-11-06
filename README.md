# porão

A private room for watching one friend's screen together, with voice chat.
Password protected and self-hosted. Linux hosts only, because the containers use
host networking.

It runs three containers:

- **LiveKit** relays media. The streamer uploads once and the server sends it to everyone else.
- **app** handles the password and serves the frontend.
- **Caddy** provides HTTPS, which browsers require for mic and screen capture.

## Running it

```bash
./setup.sh                      # asks for the host and password, writes .env
docker compose up -d --build
```

Forward these ports on your router to this machine:

| Port | Protocol | Used for |
| ---- | -------- | -------- |
| 443  | TCP | The site |
| 80   | TCP | Certificate issuing (domains only) |
| 7882 | UDP | Audio and video |
| 7881 | TCP | Audio and video when UDP is blocked |

Give this machine a fixed LAN IP, or the forwards will break when it changes.

If the host runs a firewall, open the same ports there too. The containers use host
networking, so firewall rules apply to them. With ufw:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 7882/udp
```

Then send your friends `https://<host>` and the password.

### Domain or IP

Use a domain if you can. A free one from [DuckDNS](https://www.duckdns.org) works,
and Caddy gets a real certificate for it automatically. It also keeps working when
your home IP changes, as long as the DNS record is updated.

With a plain IP, the site still works, but each friend has to click through a
browser certificate warning.

The site only answers on the addresses in `PUBLIC_HOST`, and anything else fails with
a TLS error. To allow several, separate them with a comma in `.env`, for example
`PUBLIC_HOST='friends.duckdns.org, 192.168.0.213'`, then run `docker compose up -d`.

If your home IP changes, run `docker compose restart livekit` so LiveKit picks up
the new address.

### If friends can't connect

**Page doesn't load:** the port forward for 443 isn't working. Check for CGNAT by
comparing the WAN IP on your router's status page with `curl ifconfig.me`. If they
differ, your ISP shares your public IP and port forwarding can't work. You can ask
the ISP for a public IP, host this on a small VPS, or put everyone on a VPN such as
ZeroTier or Tailscale and use the VPN IP as the host.

**Page loads but the room won't connect, or there's no video:** the forwards for
7881 and 7882 aren't working.

## Sharing

Use Chrome or Edge on Windows. In the browser's picker, choose **Entire screen** and
turn on **Also share system audio**. Sharing a single window usually has no sound,
and Firefox never shares audio. The page warns the streamer when no sound is coming
through.

Chrome and Edge keep the voice chat out of the shared audio, so nobody hears
themselves back. Very old versions don't support this and will echo.

The stream starts soft and sharpens within about 30 seconds as the connection
ramps up.

## Bandwidth

The host's upload is the limit, at roughly the stream bitrate per viewer. Five viewers
on the 1080p 60 preset can use up to 40 Mbps. The 720p 60 preset needs a little over
half that. Viewers who can't keep up drop to a 540p layer without affecting anyone else.

## Changing the password

Run `./setup.sh` again, then `docker compose up -d`. Everyone is logged out.
