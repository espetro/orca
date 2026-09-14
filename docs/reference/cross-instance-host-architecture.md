# Cross-instance host architecture

How Orca connects multiple Orca installs — a desktop on your laptop, a headless
`orca serve` on a remote machine, and the Orca mobile app — and what survives a
host going offline. The user-facing setup pages ([Remote Orca Servers](/docs/remote-servers),
[Mobile companion](/docs/mobile)) cover how to pair each transport. This page
covers the model underneath: which state lives where, why two paired hosts are
independent, and how the mobile picks between direct, Tailscale, and Relay.

## The rule

**Every Orca install is a separate host.** Each install — desktop `orca`,
headless `orca serve`, or any future runtime shape — has its own X25519 keypair
in its user-data directory, derives its own `relayHostId` from that keypair,
and registers with the Orca Relay as an independent endpoint. The mobile
pairs to each one separately and holds a separate device credential per host.

Consequences, all downstream of this rule:

1. **No host is in the middle of another's session.** The desktop never proxies
   mobile ↔ `orca serve`. The relay cell splices phone to host directly; the
   other host is irrelevant to that conversation.
2. **Turning off one host does not affect another host's sessions.** A
   worktree or agent session owned by host X dies only when X dies. Host Y
   keeps running.
3. **There is no fan-out.** The mobile picks one active host at a time. If
   you pair the mobile to both your laptop and your server, you see one
   combined worktree list, but RPC calls and agent traffic go to whichever
   host the mobile currently considers the active connection.

The closest existing statement of the principle is
[SSH Execution Boundary](./ssh-execution-boundary.md#the-rule): "the execution
host owns everything that touches execution." The same rule applies between
hosts — a host owns its own worktrees, PTYs, agent sessions, and provider
credentials. No other host can read or take over that state.

## What runs where

| Concern                                      | Lives in                          | Visible to other instances? |
| -------------------------------------------- | --------------------------------- | --------------------------- |
| Agent sessions, terminal PTYs                | The host that started them        | No                          |
| Worktrees, repos, filesystem state           | The host's filesystem             | No                          |
| Provider credentials, accounts, OAuth tokens | The host that ran `account add`   | No                          |
| Active Server selection, recent projects     | The mobile (per-device)           | Only this mobile            |
| Push notifications                           | The paired desktop's push gateway | Indirect (registered push tokens only) |
| `(phone, host)` routing                      | The Orca Relay cell               | Yes (within one user)       |
| Mobile device credentials                    | Each host's local registry + relay | Yes, but only routing-table state |

The mobile lists worktrees from every host it's paired to in a single sidebar
(read from each host independently on demand), but agent traffic and terminal
PTYs are pinned to the host that owns them.

## The three transports

The mobile has three ways to reach a host, and it picks one per host. The
selection is a label (`MobileConnectionPath` in
`mobile/src/transport/stable-logical-rpc-client.ts`), not a different wire
protocol — both `lan` and `tailscale` end up at the same host WebSocket
server.

| Path        | Wire                                                   | When picked                                    |
| ----------- | ------------------------------------------------------ | ---------------------------------------------- |
| `lan`       | Direct WS to host's runtime port on the local network | RFC1918 / private IPv6 address on the LAN      |
| `tailscale` | Direct WS to host's runtime port over Tailscale        | `100.64.0.0/10` IPv4, `*.ts.net`, `fd7a:115c:…`|
| `relay`     | WS to a cloud relay cell, spliced to the host          | Anything else — no direct route                |

Tailscale detection happens by URL heuristic — if the endpoint hostname ends
in `.ts.net` or matches `100.\d{1,3}.\d{1,3}.\d{1,3}`, the path is labelled
`tailscale`. Otherwise `lan`. The transport code path is identical; only the
label differs, and only the label affects error hints the user sees
([Tailscale Funnel reverted to tailnet-only](../shared/remote-runtime-tailscale-hint.ts)
vs the generic "connect both devices to Tailscale").

The mobile races the direct path against the relay path in parallel
(`mobile/src/transport/use-all-host-clients.ts`). Whichever authenticates
first wins. The relay path is the fallback when direct dies — typically
after a 2-second reconnect grace
(`mobile/src/transport/mobile-direct-endpoint-probe.ts`).

## The Orca Relay, in one paragraph

The Orca Relay (`cloud/apps/relay`) is a Cloud Run + GCE service that owns
**the splice between a phone and a host**. Phones and hosts never talk to
each other directly across the public internet; each opens an *outbound*
WebSocket to a relay cell. A separate director service assigns hosts to
cells and coordinates regional rehoming.

The wire looks like this:

- Host → cell: `WS /v1/host/control` for control frames
  (create-invite, revoke-device, install-credential, auth-refresh) and
  `WS /v1/host/data` for the per-connection splice.
- Phone → cell: `WS /v1/connect/{relayHostId}` carrying the host's
  resume credential.
- Cell: splices frames between the matching `(phone, host)` pair on its
  data plane. The splice lives inside the cell; neither peer knows the
  other's address.

Loss of the host's WebSocket to the cell releases the phone's session on
the cell's data plane; the phone's RPC surface sees the connection drop,
the supervisor (`use-all-host-clients`) tries a 2-second reconnect grace,
and on failure marks the host unreachable. A pair of outbound
WebSockets — never an inbound port — is the only thing each peer needs.

The relay holds *only* the routing table: which `relayHostId` belongs to
which user, which phone devices have valid credentials for which host, and
the in-flight splice state. It does **not** hold worktrees, agent
sessions, transcripts, or any execution state. A cell can be replaced at
any time and the user sees a brief reconnect, not a state loss.

## What survives a host going offline

By host:

- **Desktop turned off.** Any session on that host — agent sessions, PTYs,
  worktree state held in its renderer — ends. The phone's connection to it
  drops, the relay cell sees the close, the phone's connection to the cell
  also drops. Other paired hosts are unaffected. The phone retries via the
  relay path; if the desktop had no Relay session (no cloud auth, or
  cloud auth not configured), the host is just gone until the user turns
  the laptop back on.
- **`orca serve` turned off.** Same as above for sessions owned by that
  server. The desktop and any other host are unaffected.
- **Mobile backgrounded or network dropped.** Host-side sessions keep
  running. The relay's outbound WebSocket from the host stays up because
  the host, not the phone, is the always-on side. When the mobile comes
  back, the supervisor reconnects via whichever path is reachable.

By transport:

- **Tailscale dies.** The phone's `tailscale`/`lan` direct path to that
  host fails. The relay path is the fallback, if the host registered
  with the relay. If the host is desktop-only with no Relay registration,
  the host is gone until the user fixes Tailscale.
- **Relay cell migration.** The cell can be replaced at any time; the
  director handles rehoming. The phone sees a brief reconnect, the host
  re-binds to the new cell via `RelayControlOrigin.rebind`
  (`src/main/runtime/relay/relay-control-origin.ts:106-131`), and work
  resumes. No data loss.

## Why each install is its own `relayHostId`

The `relayHostId` is derived from the X25519 keypair stored in the host's
user-data directory (`deriveRelayHostId` in
`src/main/runtime/relay/relay-http-client.ts`). That means:

- A new Orca install on a new machine is a new host from the relay's
  point of view, even if it's the same Orca account. Pairing is per host.
- Re-installing Orca on the same machine with the same user-data directory
  yields the same `relayHostId` and existing paired devices reconnect
  with their saved tokens.
- Removing a user-data directory is equivalent to removing a host from
  the relay's view.

There is no automatic credential migration between two distinct
`relayHostId`s — they are separate host identities.

## When `orca serve` and the desktop are the same machine

Pick one. The desktop and `orca serve` share the same X25519 keypair only
if they share the same user-data directory (they don't, by default —
desktop writes to `app.getPath('userData')` and `orca serve` to its
`ORCA_USER_DATA` root). Starting both on the same machine creates two
distinct hosts, two `relayHostId`s, and two sets of paired-device
credentials. The mobile would see the same machine twice. The
[Remote Orca Servers](/docs/remote-servers) page is explicit: "Use only
one host mode at a time. If the Orca desktop app is already sharing that
computer, do not start a second `orca serve` process for the same setup."

## Where this is implemented

| Concern                                   | Source                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| Director HTTP assign, host key proof       | `src/main/runtime/relay/relay-http-client.ts`, `relay-host-proof.ts`      |
| Host control / data sockets               | `src/main/runtime/relay/relay-control-client.ts`, `relay-control-origin.ts` |
| Host service (shared by desktop + serve)   | `src/main/runtime/relay/desktop-relay-service.ts`, wired in `src/main/startup/main-process-runtime-launch.ts:255` |
| `orca serve` (a.k.a. `orcad`) entry       | `src/main/orcad/orcad-entry.ts`                                           |
| Mobile connection paths                   | `mobile/src/transport/stable-logical-rpc-client.ts`, `mobile-direct-endpoint-probe.ts`, `use-all-host-clients.ts` |
| Tailscale detection                       | `src/shared/tailnet-address.ts`, `src/shared/remote-runtime-tailscale-hint.ts` |
| Pairing address ranking                   | `src/main/runtime/pairing-network-interfaces.ts`                          |

The wire-protocol contract (what changes break mixed-version pairings) is
in [Remote wire compatibility](./remote-wire-compatibility.md).
