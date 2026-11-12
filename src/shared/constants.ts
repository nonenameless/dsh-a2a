/**
 * Fixed protocol paths, limits, and credential addresses.
 *
 * Deployment-varying values live in the plugin Config, never here. These are
 * protocol constants or security floors that a profile must not be able to
 * turn into an unbounded request surface.
 *
 * @module @local/dsh-a2a/constants
 */

/** Plugin row and logger prefix. */
export const PLUGIN_NAME = 'dsh-a2a'

/** Context service name published by this plugin. */
export const SERVICE_NAME = 'a2a'

/** Requested discovery path (A2A 0.2 style, kept as the primary path by this plugin). */
export const DEFAULT_AGENT_CARD_PATH = '/.well-known/agent.json'

/** A2A 0.3 canonical discovery path; served as an alias with the same body. */
export const CANONICAL_AGENT_CARD_PATH = '/.well-known/agent-card.json'

/** JSON-RPC endpoint path. */
export const DEFAULT_RPC_PATH = '/a2a'

/** Non-standard liveness probe; never used by A2A peers. */
export const HEALTH_PATH = '/a2a/health'

/** Browser-facing management API prefix. */
export const ADMIN_PREFIX = '/a2a/admin'

/** Management snapshot consumed by the settings panel. */
export const ADMIN_STATE_PATH = `${ADMIN_PREFIX}/state`

/** Add or replace one remote node. */
export const ADMIN_NODES_PATH = `${ADMIN_PREFIX}/nodes`

/** Remove one remote node. */
export const ADMIN_NODE_DELETE_PATH = `${ADMIN_PREFIX}/nodes/delete`

/** Re-discover one remote node. */
export const ADMIN_NODE_REFRESH_PATH = `${ADMIN_PREFIX}/nodes/refresh`

/** Store or clear the inbound bearer token. */
export const ADMIN_INBOUND_TOKEN_PATH = `${ADMIN_PREFIX}/inbound-token`

/** Store or clear one node's bearer token. */
export const ADMIN_NODE_TOKEN_PATH = `${ADMIN_PREFIX}/node-token`

/** Store or clear one inbound peer's bearer token. */
export const ADMIN_PEER_TOKEN_PATH = `${ADMIN_PREFIX}/peer-token`

/** Default request-body cap for the JSON-RPC endpoint. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576

/** A bearer token longer than this is rejected before hashing. */
export const MAX_TOKEN_LENGTH = 4_096

/** Default end-to-end budget for one inbound task. */
export const DEFAULT_SERVER_TIMEOUT_MS = 600_000

/** Default per-request budget for one outbound A2A call. */
export const DEFAULT_CLIENT_TIMEOUT_MS = 120_000

/** Agent Card discovery is capped below the task budget so activation stays responsive. */
export const DISCOVERY_TIMEOUT_MS = 10_000

/** Default number of retained log entries shown by the panel. */
export const DEFAULT_LOG_CAPACITY = 500

/** Credential record holding the inbound bearer token: `<owner>/<id>`. */
export const INBOUND_CREDENTIAL_KEY = 'dsh-a2a/inbound'

/**
 * Credential record prefix for a remote node's bearer token.
 *
 * DSH credential records are exactly `<scope>/<id>`, and each segment matches
 * `[a-z][a-z0-9-]*`. The prefix therefore ends in `-`: a trailing slash would
 * make `dsh-a2a/node/<id>` a three-segment key, which the credentials loader
 * rejects at the next boot.
 */
export const NODE_CREDENTIAL_PREFIX = 'dsh-a2a/node-'

/**
 * Credential record prefix for one inbound peer's bearer token.
 *
 * The legacy single inbound token keeps its `dsh-a2a/inbound` record; peers
 * listed in `server.auth.peers` each get `dsh-a2a/peer-<id>`.
 */
export const PEER_CREDENTIAL_PREFIX = 'dsh-a2a/peer-'

/** `WWW-Authenticate` realm for the inbound endpoint. */
export const BEARER_REALM = 'dsh-a2a'

/** Environment variable consulted when no credential record is stored. */
export const DEFAULT_TOKEN_ENV = 'DSH_A2A_TOKEN'

/** Header carrying the inbound token. */
export const AUTHORIZATION_HEADER = 'authorization'

/** JSON body media type accepted by the RPC endpoint. */
export const JSON_CONTENT_TYPE = 'application/json'

/** SSE media type used by streaming methods. */
export const SSE_CONTENT_TYPE = 'text/event-stream'
