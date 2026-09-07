# Deploy with podman

lambdock is published as a multi-architecture image on the GitHub container registry. It runs on
`linux/amd64` and `linux/arm64`.

```
ghcr.io/jotoh98/lambdock:latest
```

The image is public. You do not need a registry login to pull it.

## 1. Start with podman-compose

```bash
mkdir -p ~/lambdock && cd ~/lambdock
curl -O https://raw.githubusercontent.com/jotoh98/lambdock/main/compose.yaml
podman-compose up -d
```

Open <http://SERVER:8000/__/>.

`compose.yaml`:

```yaml
services:
  lambdock:
    image: ghcr.io/jotoh98/lambdock:latest
    container_name: lambdock
    ports:
      - "8000:8000"
    volumes:
      - ./data:/data:Z
    environment:
      LAMBDOCK_DATA: /data
      LAMBDOCK_PORT: "8000"
      LAMBDOCK_TYPECHECK: "1"
    restart: unless-stopped
```

The `:Z` suffix sets the SELinux label. It is necessary on Fedora, RHEL and CentOS. On other systems
it does no damage.

## 2. Start without compose

```bash
podman run -d \
  --name lambdock \
  -p 8000:8000 \
  -v ~/lambdock/data:/data:Z \
  --restart unless-stopped \
  ghcr.io/jotoh98/lambdock:latest
```

## File ownership with rootless podman

The container process runs as root inside the container. With rootless podman, that root maps to
**your own user** on the host. Files in `./data` therefore belong to you, and you can edit them with
your normal editor.

Check it:

```bash
ls -l ~/lambdock/data/functions/hello/
# -rw-r--r-- 1 youruser youruser ... handler.ts
```

If your podman uses a different mapping, and the container cannot write, add `--userns=keep-id`:

```bash
podman run -d --userns=keep-id -v ~/lambdock/data:/data:Z ... ghcr.io/jotoh98/lambdock:latest
```

## Start at boot with systemd

Rootless podman starts containers with a user service. This survives a reboot.

```bash
# Generate a unit for the running container
podman generate systemd --new --name lambdock --files
mkdir -p ~/.config/systemd/user
mv container-lambdock.service ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now container-lambdock

# Keep the user services alive when you are not logged in
loginctl enable-linger "$USER"
```

Check the status:

```bash
systemctl --user status container-lambdock
podman logs -f lambdock
```

### Quadlet (podman 4.4 and later)

Quadlet is the newer method. Put this file at `~/.config/containers/systemd/lambdock.container`:

```ini
[Unit]
Description=lambdock
After=network-online.target

[Container]
Image=ghcr.io/jotoh98/lambdock:latest
ContainerName=lambdock
PublishPort=8000:8000
Volume=%h/lambdock/data:/data:Z
Environment=LAMBDOCK_DATA=/data

[Service]
Restart=always

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user start lambdock
loginctl enable-linger "$USER"
```

## Update to a new version

```bash
cd ~/lambdock
podman-compose pull
podman-compose up -d
```

Your functions are in `./data` on the host. An image update does not touch them.

To go back to an older version, use a version tag instead of `latest`:

```yaml
image: ghcr.io/jotoh98/lambdock:0.1.0
```

## Health check

The image has a health check on `/__/api/health`.

```bash
podman healthcheck run lambdock
curl -s http://localhost:8000/__/api/health
# {"ok":true,"functions":3}
```

## Backup

Everything is in one directory.

```bash
tar czf lambdock-backup-$(date +%F).tar.gz -C ~/lambdock data
```

Stop the container first if you want a fully consistent copy of `kv.sqlite`:

```bash
podman stop lambdock
tar czf backup.tar.gz -C ~/lambdock data
podman start lambdock
```

To restore, put the `data` directory back and start the container.

## Put it behind a proxy

lambdock has **no authentication**. Add a password at the proxy if the server is reachable from
outside your network.

Caddy:

```
lambdock.example.com {
    basic_auth {
        admin $2a$14$...   # caddy hash-password
    }
    reverse_proxy localhost:8000
}
```

You can also protect only the editor, and leave the functions open:

```
lambdock.example.com {
    handle /__/* {
        basic_auth { admin $2a$14$... }
        reverse_proxy localhost:8000
    }
    handle {
        reverse_proxy localhost:8000
    }
}
```

## Build the image yourself

```bash
git clone https://github.com/jotoh98/lambdock.git
cd lambdock
podman build -t lambdock:local .
podman-compose -f compose.dev.yaml up -d
```

## Publish your own image

The workflow `.github/workflows/release.yml` builds and pushes the image. It runs on every push to
`main` and on every `v*` tag. It needs no secret, because it uses the automatic `GITHUB_TOKEN`.

To make a version:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Tags produced: `latest`, `0.1.0`, `0.1`, and the short commit hash.

After the first push, open the package page on GitHub and set the visibility to public. Then no
login is necessary to pull.

## Problems

| Symptom                                           | Cause and repair                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `permission denied` on `/data`                    | Add `--userns=keep-id`, or `chown` the directory to your user.                                                     |
| The editor is empty                               | The browser blocked `vendor/editor.js`. Look in the developer console. The editor falls back to a plain text area. |
| The Problems tab says `no --allow-run permission` | The type check needs `--allow-run`. Set `LAMBDOCK_TYPECHECK=0` to hide the message.                                |
| Port 8000 is in use                               | Change the left side of `"8000:8000"` in `compose.yaml`.                                                           |
