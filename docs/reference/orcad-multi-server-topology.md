# orcad Multi-Server Topology

How to run several `orcad` daemons and reach them from a browser and several mobiles, with
no single machine that everything depends on. This is the topology the fork maintains: each
orcad is an independent runtime; clients hold one connection per orcad they care about.

See [`orcad-operations.md`](./orcad-operations.md) for the single-daemon contract (bind
policy, offer lifetime, what readiness proves). This document is about placement and
reachability between daemons and clients.

## Roles

| Role    | Process                       | Serves                                                   | Connects to                                    |
| ------- | ----------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| orcad   | `orcad` (headless Node)       | `ws://<bind>:<port>` RPC; `orca-environments.json` store | nothing — it is the target                     |
| web app | `orcad --serve` static bundle | the browser UI itself                                    | one orcad per registered environment           |
| browser | any tab                       | —                                                        | `ws://` each registered environment            |
| mobile  | the app                       | —                                                        | `ws://` each paired host, `/h/[hostId]` routes |

A single orcad can be both a target and a `--serve` host. The web bundle is identical
everywhere; whichever orcad serves it only decides where assets come from, not which
daemons the tab can reach — that is the browser's own environment registry.

## Reference layout

```
                 ┌──────────────┐
   browser ────► │ home orcad   │◄──── mobile A ──┐
   (tabs to all) │  --serve     │                 │
                 └──────────────┘                 │   (each mobile pairs each
                 ┌──────────────┐                 │    host directly; no relay
                 │ other-PC     │◄────────────────┤    goes through the home
                 │ orcad (LAN)  │                 │    machine)
                 └──────────────┘                 │
                 ┌──────────────┐                 │
   browser ────► │ VPS orcad    │◄────────────────┘
   (even when    │ --serve +    │◄──── mobile B
    home is off) │  public bind │
                 └──────────────┘
```

## Connectivity matrix

"Main computer" = the machine that normally serves the web app.

| Path                     | Main computer on                    | Main computer off                                      |
| ------------------------ | ----------------------------------- | ------------------------------------------------------ |
| browser → home orcad     | direct `ws://` or SSH `-L`          | unreachable — serve the web app from the VPS instead   |
| browser → other-PC orcad | same LAN `ws://`                    | still works — the tab only needs the target's endpoint |
| browser → VPS orcad      | `ws://` public/overlay, or SSH `-L` | still works                                            |
| mobile → home orcad      | direct                              | unreachable — it _is_ the main computer                |
| mobile → other-PC orcad  | direct (same LAN or overlay)        | works if the PC is up and reachable                    |
| mobile → VPS orcad       | direct                              | works — no dependency on the home machine              |

The pairing credential lives on the target orcad (`deviceToken` + `publicKeyB64` in the
client's stored endpoint, and the matching record in that orcad's pairing store). Nothing in
the steady state routes through the home machine — the only home-dependent flows are
"whatever the home orcad itself serves".

## Pairing each link

Every arrow is created once, then persists until rotated:

- **VPS orcad ↔ mobile**: run `orca server link --reach network --address <vps-ip>` (or the
  overlay address) _on the VPS_ — the URL is minted from that machine's own runtime state
  and refuses remote-selection flags on purpose. Enter or scan it on the phone.
- **other-PC orcad ↔ mobile**: same command on that PC; `--reach network` resolves the LAN
  default. While an orcad's bind is pinned to loopback, a network offer is refused with
  `network_exposure_failed` rather than minting a URL nothing can serve — start it with
  `--bind 0.0.0.0` (or a specific interface) first.
- **browser ↔ external orcad**: the same `server link` offer, or Add Server in the web UI.
  `environmentStore.add` writes it into that orcad's `orca-environments.json`; the browser
  also keeps its own registry (`orca.web.runtimeEnvironments`) and merges the server-side
  list on `list()`. One web client can hold every orcad as a separate environment.

`--reach this-computer` is deliberately loopback-only: it must not resolve a LAN address a
loopback listener cannot serve. Use it for same-machine pairing (the local browser tab),
not for anything crossing a network.

## Exposure choices per orcad

| Path                   | Command                                                        | When                                                                    |
| ---------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Loopback + SSH forward | `--bind 127.0.0.1` (default), `ssh -L <port>:127.0.0.1:<port>` | upstream's model; safest on any host that has SSH                       |
| Explicit interface     | `--bind <lan-ip>`                                              | LAN-scoped reach                                                        |
| All interfaces         | `--bind 0.0.0.0`                                               | VPS or trusted overlay only — the pairing token is the whole credential |

The bind is pinned at launch and only the documented widenings (a `network`-reach offer,
an already-connected device) rebind it. A pinned loopback `--port` that collides still
falls back to an OS-assigned port today — pin the port only where failure is acceptable.

**On the VPS prefer an overlay (Tailscale/WireGuard) plus `--bind <overlay-ip>`** over a
public `0.0.0.0`: the pairing token is bearer auth and there is no second factor, so the
smaller the listener's routable surface, the better. SSH `-L` against a loopback bind is
the zero-open-port fallback and needs no orcad-side changes.

## Always-on checklist for "main computer off"

1. Pick the machine that is always up (the VPS) and run `orcad --serve` there too — the
   web app is per-orcad, so the browser keeps working with zero home-machine dependency.
2. Pair every mobile with every orcad it should reach (`server link` per host, per device).
   The pairing store is multi-device already; `--rotate` mints a fresh offer without
   breaking already-paired devices.
3. Register every orcad as an environment in the web client, including the VPS itself —
   `environmentStore.add` on the serving orcad makes the env list survive across browsers
   via `environmentStore.list` merge.
4. Give each orcad a stable address (DNS, overlay IP, or static LAN). Endpoints are stored
   literally; a DHCP'd LAN address will go `unverifiable`, not self-heal.
5. Keep `orca-environments.json` and the pairing store private — they are bearer
   credentials for every registered host.

## Failure vocabulary

Unreachable environments report with the SSH-execution-boundary verdicts
(`live` / `unverifiable` / `exited`), never "dead": an off home machine is `unverifiable`
to its clients, not evidence the work on it is gone. A browser tab to a downed orcad fails
its `status.get` poll and the environment shows offline; reconnecting restores it without
re-pairing. On the web side, a disposed status owner is rebuilt rather than latched, so a
flapping link does not wedge the explorer.

## What is not covered

Named here so nothing reads as implemented that is not:

- **Cross-orcad worktree or session federation.** Each orcad owns its own worktrees and
  snapshot; nothing syncs sessions between daemons. Switching environments switches the
  whole workspace view.
- **Mobile → mobile.** Mobiles are clients only; they cannot act as runtimes for each
  other.
- **Store replication.** `orca-environments.json` is per-orcad; adding the same remote on
  two servers means adding it twice (the browser-side merge only reads it).
- **Relay reach for headless hosts.** The desktop relay provider is not attached on orcad;
  `automatic` connection mode fails closed with `relay_mint_failed` there. All links above
  are direct `ws://` or SSH-forwarded.
- **Credential administration.** Listing, revoking, or expiring already-paired devices is
  not implemented — `--rotate` replaces the _offer_, not issued device credentials.
