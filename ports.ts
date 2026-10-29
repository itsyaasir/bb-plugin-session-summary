// Servers running in a thread's folder: pure parsing and naming, so the tests
// need no lsof or docker. host.ts runs the commands. Adapted from the MIT
// Worktree Ports plugin (github.com/to-infinity-labs/bb-plugin-worktree-ports),
// narrowed from every worktree to one folder.
import { z } from "zod";
import { portSchema, type ThreadPort } from "./contract.ts";

export interface Listener {
  pid: number;
  process: string;
  address: string;
  port: number;
}

export interface DockerRow {
  name: string;
  workingDir: string;
  /** com.docker.compose.service, or null for a container outside compose. */
  service: string | null;
  ports: { port: number; address: string }[];
}

export interface PortLabel {
  label: string;
  scheme: "http" | "https" | null;
}

/** `*:3000`, `127.0.0.1:3000`, `[::1]:3000`, `[::]:3000`. */
function parseAddressPort(value: string): { address: string; port: number } | null {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value);
  if (match === null) return null;
  const port = Number.parseInt(match[3]!, 10);
  if (!portSchema.safeParse(port).success) return null;
  const host = match[1] ?? match[2] ?? "*";
  return { address: host === "*" ? "0.0.0.0" : host, port };
}

/**
 * Columnar `lsof -nP -iTCP -sTCP:LISTEN` output. lsof escapes spaces in the
 * COMMAND column as `\x20`, so splitting on whitespace is safe.
 */
export function parseListeners(output: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of output.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 9) continue;
    const pid = Number.parseInt(columns[1]!, 10);
    // NAME sits before the trailing "(LISTEN)".
    const parsed = parseAddressPort(columns[columns.length - 2]!);
    if (!Number.isInteger(pid) || parsed === null) continue;
    listeners.push({ pid, process: columns[0]!.replaceAll("\\x20", " "), ...parsed });
  }
  return listeners;
}

/** Field-mode `lsof -a -p <pids> -d cwd -Fn` output: `p<pid>`, `fcwd`, `n<path>`. */
export function parseCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) ? parsed : null;
    } else if (line.startsWith("n") && pid !== null && !cwds.has(pid)) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

/** `docker ps` rows: name \t ports \t compose working dir \t compose service. */
export function parseDockerRows(output: string): DockerRow[] {
  const rows: DockerRow[] = [];
  for (const line of output.split("\n")) {
    const [name, ports = "", workingDir = "", service = ""] = line.split("\t");
    if (name === undefined || name.trim() === "" || workingDir.trim() === "") continue;
    rows.push({
      name: name.trim(),
      workingDir: workingDir.trim(),
      service: service.trim() || null,
      ports: parseDockerPorts(ports),
    });
  }
  return rows;
}

/**
 * `0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp`: only published mappings (with
 * `->`) reach the host, and the IPv4 and IPv6 pair is one port.
 */
function parseDockerPorts(value: string): { port: number; address: string }[] {
  const seen = new Map<number, string>();
  for (const entry of value.split(",")) {
    const arrow = entry.indexOf("->");
    if (arrow === -1) continue;
    const parsed = parseAddressPort(entry.slice(0, arrow).trim());
    if (parsed === null) continue;
    if (!seen.has(parsed.port) || parsed.address.includes(".")) seen.set(parsed.port, parsed.address);
  }
  return [...seen].map(([port, address]) => ({ port, address }));
}

/** True when `path` is `folder` or inside it, on either path separator. */
export function isInside(path: string, folder: string): boolean {
  const root = folder.replace(/[/\\]+$/, "");
  return path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
}

const portLabelSchema = z.object({
  port: portSchema,
  label: z.string().trim().min(1),
  scheme: z.enum(["http", "https"]).nullish().catch(null),
});

/**
 * The folder's `.bb/ports.json`, shared with the Worktree Ports plugin:
 * `{"ports": [{"port": 3000, "label": "Web", "scheme": "https"}]}`. It only
 * names ports already listening, and a malformed file names nothing.
 */
export function parseLabels(content: string): Map<number, PortLabel> {
  const labels = new Map<number, PortLabel>();
  let entries: unknown;
  try {
    entries = (JSON.parse(content) as { ports?: unknown } | null)?.ports;
  } catch {
    return labels;
  }
  if (!Array.isArray(entries)) return labels;
  for (const entry of entries) {
    const parsed = portLabelSchema.safeParse(entry);
    if (!parsed.success) continue;
    const { port, label, scheme } = parsed.data;
    labels.set(port, { label: label.slice(0, 80), scheme: scheme ?? null });
  }
  return labels;
}

/** Backing services run outside Docker, matched on the lsof COMMAND. */
const SERVICE_PROCESSES = new Set([
  "postgres", "postmaster", "redis-server", "redis-serv", "mongod", "mysqld", "mariadbd",
  "memcached", "mailpit", "nats-server", "etcd", "minio", "clickhouse", "beam.smp",
]);

/** Well-known service ports, for when the process name says nothing. */
const SERVICE_PORTS = new Map<number, string>([
  [5432, "postgres"], [3306, "mysql"], [6379, "redis"], [27017, "mongodb"], [7474, "neo4j"],
  [7687, "neo4j"], [9200, "elasticsearch"], [5672, "amqp"], [15672, "rabbitmq"], [1025, "smtp"],
  [8025, "mailpit"], [11211, "memcached"], [4222, "nats"], [2379, "etcd"], [9092, "kafka"],
  [2181, "zookeeper"],
]);

/** The IANA dynamic range, where nothing chooses its own port. */
const EPHEMERAL_FROM = 49152;

type Unnamed = Omit<ThreadPort, "role" | "name" | "url">;

/** A listener found on the machine, before ports.json names it. */
export type ScannedPort = Omit<Unnamed, "label">;

/**
 * What a port is for: the app being developed, a backing service, or an
 * internal loopback listener nobody opens in a browser.
 */
function roleFor(port: Unnamed): ThreadPort["role"] {
  // A ports.json label says "this one matters".
  if (port.label !== null) return "app";
  if (port.source === "docker") return "service";
  if (SERVICE_PROCESSES.has(port.process.toLowerCase()) || SERVICE_PORTS.has(port.port)) return "service";
  const loopback = port.address.startsWith("127.") || port.address === "::1";
  return loopback && port.port >= EPHEMERAL_FROM ? "internal" : "app";
}

/** The label, else the compose service or container, else the process. */
function nameFor(port: Unnamed, role: ThreadPort["role"]): string {
  if (port.label !== null) return port.label;
  if (port.source === "docker") return port.service ?? port.container ?? "docker";
  return role === "service" ? (SERVICE_PORTS.get(port.port) ?? port.process) : port.process;
}

const ROLE_RANK: Record<ThreadPort["role"], number> = { app: 0, service: 1, internal: 2 };

/**
 * One row per port, named and ordered apps first. A port seen by both the
 * process and docker passes keeps its process row.
 */
export function finishPorts(rows: ScannedPort[], labels: Map<number, PortLabel>): ThreadPort[] {
  const byPort = new Map<number, ThreadPort>();
  for (const row of rows) {
    if (byPort.get(row.port)?.source === "process") continue;
    const known = labels.get(row.port);
    const labelled = { ...row, label: known?.label ?? null };
    const role = roleFor(labelled);
    // Ports in the 443 family are TLS often enough to be worth guessing.
    const protocol = known?.scheme ?? (String(row.port).endsWith("443") ? "https" : "http");
    byPort.set(row.port, { ...labelled, role, name: nameFor(labelled, role), url: `${protocol}://localhost:${row.port}` });
  }
  return [...byPort.values()].sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.port - b.port);
}
