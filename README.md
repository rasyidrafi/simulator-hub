# simulator-hub

A standalone HTTP API for one Android Virtual Device (AVD). Clients can poll PNG frames and send touch or key events. The server owns the control lease, so two integrations cannot both drive the screen. No OpenChamber installation is required.

## Run on the emulator host

Use Bun 1.4.5+, Android SDK `platform-tools` and `emulator` on `PATH`, and an existing AVD (`emulator -list-avds`). Reserve emulator port 5554 for this AVD. Run as an ordinary user with access to the SDK, the AVD and hardware acceleration. No Node.js installation or package install is required.

```sh
export HUB_AVD=Pixel_API_35  # replace with an existing AVD name
export HUB_STATE_DIR="$HOME/.local/state/simulator-hub"
export HUB_ADMIN_TOKEN="$(openssl rand -hex 32)"
export PORT=8787
bun run start
```

Provision the admin secret through your service environment for repeat use. Protect it like a password: it can revoke credentials and stop the emulator. Give each client its own operator token instead of sharing the admin token. Keep credentials on the client backend, not in browser code or URLs.

## Register as a Linux user service

From this checkout, run `HUB_AVD=Pixel_API_35 bash scripts/install-service.sh` (replace the name with one from `emulator -list-avds`). Requires a working systemd user session, Bun, `adb`, `emulator`, and OpenSSL. The helper registers the **current checkout**; keep it and the resolved Bun executable in place.

On first install it generates an admin credential in `~/.config/simulator-hub/server.env` (mode `0600`), sets port 8787, and enables and starts the API with `NODE_ENV=production`. It reuses existing configuration, does not overwrite a different unit or restart a running service, and does not boot an AVD. If your SDK needs an explicit location, set `ANDROID_HOME` in `server.env`. Config and unit files respect `XDG_CONFIG_HOME`.

- Status: `systemctl --user status simulator-hub.service`
- Logs: `journalctl --user -u simulator-hub.service -f`
- Apply server or environment changes: `systemctl --user restart simulator-hub.service` (interrupts active sessions).
- Start the user manager at boot without logging in: `loginctl enable-linger "$USER"` if permitted by the host.
- Disable and stop: `systemctl --user disable --now simulator-hub.service`. Credentials and state remain on disk.

For unattended startup, add `HUB_AUTOSTART=1` to `server.env` before starting or restarting the service. By default the API leaves the AVD stopped. Autostart attempts launch once per service start, leaves an already running managed AVD alone, and does not undo a manual stop. Poll `GET /v1/devices` for readiness; use `POST /v1/device/start` as admin to start manually.

## Connect from another laptop

### Register additional Android devices

The default `HUB_AVD` remains on port 5554. Register additional devices by creating or editing `$HUB_STATE_DIR/devices.json` (a JSON array), then restart the Hub during an idle maintenance window. A restart interrupts existing sessions. Only explicitly registered targets are exposed; all existing authenticated Hub clients can access them. Remove an entry and restart to unregister it.

```json
[
  {"id":"test-phone","name":"Test phone","type":"physical","serial":"SERIAL_FROM_ADB_DEVICES"},
  {"id":"tablet","name":"Test tablet","type":"emulator","avd":"Existing_Tablet_AVD","port":5556}
]
```

Use a unique stable API ID and ADB serial for each phone (USB debugging must be authorized). For an additional emulator, provision the named AVD first and reserve a unique even console port. Start additional AVDs explicitly; phone start/stop is not supported. An unplugged phone stays listed as `offline`.

`GET /v1/devices` lists the registered targets. Pass `?device=<id>` on **every** device-specific request, including `/v1/live`, `/v1/lease`, `/v1/device/input`, and `/v1/device/screenshot`. Capture, input, and lease ownership are scoped to that ID. Omitting the selector preserves the default emulator; an unknown ID returns 404. Token management is global.

### HTTPS deployment: enable live video and touch

Keep your **existing HTTPS domain and port**. The reverse proxy terminates TLS and forwards `/v1/live` WebSocket upgrades (HTTP/1.1, `Upgrade`, `Connection`, and `Authorization`) to the same loopback Hub as your REST requests. Preserve any existing external path prefix. No browser CORS changes, public ADB port, SSH tunnel, or second listener are required for this deployment. Use TLS with a certificate trusted by the OpenChamber server.

On the emulator host, from the updated checkout:

```sh
bun install --frozen-lockfile
mkdir -p "$HOME/.local/share/simulator-hub"
curl -fL https://github.com/Genymobile/scrcpy/releases/download/v3.3.1/scrcpy-server-v3.3.1 -o "$HOME/.local/share/simulator-hub/scrcpy-server-v3.3.1"
printf '%s  %s\n' a0f70b20aa4998fbf658c94118cd6c8dab6abbb0647a3bdab344d70bc1ebcbb8 "$HOME/.local/share/simulator-hub/scrcpy-server-v3.3.1" | sha256sum -c -
```

Set `HUB_SCRCPY_SERVER` in the existing service environment (`~/.config/simulator-hub/server.env` for the supplied user service) to the **absolute file path**, not a shell expression. Restart `simulator-hub.service` after installing. Do not replace existing tokens, `HUB_AVD`, or state directory. The Hub verifies the pinned server hash, uses local ADB on port 5037 and reserves `emulator-5554` for the configured AVD. No desktop scrcpy client is required. Leave this variable unset to use PNG/REST only.

Open the Simulator rail with a ready device. A live session should show a moving picture and respond to a drag before pointer-up. Check your reverse proxy log for a `101` on `/v1/live`; repeated PNG requests without an upgrade indicate fallback. Close the last viewer to release capture. To roll back, unset `HUB_SCRCPY_SERVER` and restart the Hub; the original REST endpoints remain available.

### Optional tunnel for deployments without HTTPS

Keep the service on loopback. On the client laptop, open an encrypted SSH tunnel and leave it running:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8787:127.0.0.1:8787 user@emulator-host
```

The client backend now uses `http://127.0.0.1:8787`. Only SSH needs to be reachable. Do not expose ADB, the emulator console, or a plaintext bearer-token API to the network.

## API

Prefix all paths below with `/v1`. Send `Authorization: Bearer <token>` on every request. Send JSON bodies as `application/json`.

| Method and path | Purpose |
| --- | --- |
| `GET /me` | Discover the role of the current credential. |
| `POST /tokens` | Admin: issue an operator token with `{"name":"openchamber"}`. Save the returned `token` immediately. |
| `GET /tokens`, `DELETE /tokens/:id` | Admin: list token metadata or revoke a credential. |
| `GET /devices` | Client/admin inventory: `{devices:[{id,name,status,control}]}`. Currently lists only `HUB_AVD`; `id` is its stable AVD name. `control` (`free`/`in_use`) describes the lease, separately from boot status. |
| `POST /device/start`, `POST /device/stop` | Admin lifecycle controls. Poll status after starting; wait for `ready`. |
| `GET /device/screenshot` | Fetch a PNG; request the next frame after the previous one completes. No lease needed. |
| `POST /lease` | Acquire exclusive control; save the returned `id`. |
| `PUT /lease`, `DELETE /lease` | Holder: renew or release with `X-Lease-Id`. Renew before the 30-second timeout. Admin: `DELETE /lease` without a lease ID forcibly releases the active controller. |
| `POST /device/input` | With `X-Lease-Id`, send a tap, swipe or key event. |

Input examples (coordinates in current screenshot pixels):

```json
{"type":"tap","x":120,"y":300}
```
```json
{"type":"swipe","x1":120,"y1":600,"x2":120,"y2":200,"duration":300}
```
```json
{"type":"key","key":"HOME"}
```

Use `HOME`, `BACK` or `ENTER` for keys. Release the lease when done. A disconnected HTTP client cannot be detected between requests; if it vanishes, the lease times out. After a server restart clients must reacquire control.

An admin can force-release any active lease with `DELETE /v1/lease` without a lease ID, for example to recover control from an unresponsive client. Its old lease ID immediately becomes invalid.

## Verify

`bun test` launches a separate Bun server process, calls it over loopback HTTP as two clients, and substitutes isolated CLI fixtures for `adb` and `emulator`. This tests the API and command routing, not Android itself.

For a hardware-backed smoke test, start the server with a **disposable, stopped AVD**, then run `bun test/real-avd.mjs` with the same `PORT` and `HUB_ADMIN_TOKEN`. It issues a temporary operator credential, boots the AVD, sends Home, fetches a PNG, revokes the credential, and requests shutdown. Neither test configures networking or installs an SDK.
