// Why: shared between the runtime RPC server (createMobilePairingOffer) and the mobile IPC layer
// (getRuntimePairingUrl) so a failed pairing widen surfaces one consistent message. Kept in its own light
// module so the mobile IPC unit test can import the string without loading the full RPC/SSH module graph.
export const NETWORK_EXPOSURE_FAILED_GUIDANCE =
  'Could not expose the runtime to the network for pairing. If orcad was launched with a pinned loopback bind (the default), relaunch with an explicit bind such as --bind 0.0.0.0. The listener kept serving locally; otherwise retry, or choose an unused --port if the LAN bind was refused.'
