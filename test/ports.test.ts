import assert from "node:assert/strict";
import { test } from "node:test";
import { finishPorts, isInside, parseCwds, parseDockerRows, parseLabels, parseListeners } from "../ports.ts";

test("parseListeners reads lsof's columns, IPv6 and wildcard addresses", () => {
  const output = [
    "COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
    "node      41022 me     23u  IPv6 0x1234567890abcdef      0t0  TCP [::1]:5173 (LISTEN)",
    "Code\\x20H  901 me     40u  IPv4 0x1234567890abcdef      0t0  TCP 127.0.0.1:60123 (LISTEN)",
    "postgres    77 me      7u  IPv4 0x1234567890abcdef      0t0  TCP *:5432 (LISTEN)",
    "garbage line",
  ].join("\n");
  assert.deepEqual(parseListeners(output), [
    { pid: 41022, process: "node", address: "::1", port: 5173 },
    { pid: 901, process: "Code H", address: "127.0.0.1", port: 60123 },
    { pid: 77, process: "postgres", address: "0.0.0.0", port: 5432 },
  ]);
});

test("parseCwds keeps the first cwd per pid", () => {
  assert.deepEqual(parseCwds("p10\nfcwd\nn/repo/app\np11\nfcwd\nn/other\n"), new Map([[10, "/repo/app"], [11, "/other"]]));
});

test("parseDockerRows keeps compose containers and their published ports once", () => {
  const output = [
    "app-db-1\t0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp\t/repo\tdb",
    "loose\t6379/tcp\t\t",
  ].join("\n");
  assert.deepEqual(parseDockerRows(output), [
    { name: "app-db-1", workingDir: "/repo", service: "db", ports: [{ port: 5432, address: "0.0.0.0" }] },
  ]);
});

test("isInside matches the folder and its children, not siblings", () => {
  assert.equal(isInside("/repo", "/repo/"), true);
  assert.equal(isInside("/repo/web", "/repo"), true);
  assert.equal(isInside("/repo-two", "/repo"), false);
});

test("parseLabels skips malformed entries and files", () => {
  const labels = parseLabels('{"ports":[{"port":3000,"label":" Web ","scheme":"https"},{"port":"x","label":"y"},{"port":4000}]}');
  assert.deepEqual(labels, new Map([[3000, { label: "Web", scheme: "https" }]]));
  assert.equal(parseLabels("not json").size, 0);
});

test("finishPorts names, ranks, and dedupes rows", () => {
  const base = { address: "0.0.0.0", container: null, service: null };
  const ports = finishPorts(
    [
      { ...base, port: 5432, pid: 0, process: "docker", source: "docker", container: "app-db-1", service: "db" },
      { ...base, port: 60123, pid: 2, process: "node", source: "process", address: "127.0.0.1" },
      { ...base, port: 3000, pid: 1, process: "node", source: "process" },
      { ...base, port: 3000, pid: 0, process: "docker", source: "docker", container: "web" },
      { ...base, port: 8443, pid: 3, process: "caddy", source: "process" },
    ],
    new Map([[8443, { label: "Proxy", scheme: null }]]),
  );
  assert.deepEqual(
    ports.map((row) => [row.port, row.role, row.name, row.url, row.source]),
    [
      [3000, "app", "node", "http://localhost:3000", "process"],
      [8443, "app", "Proxy", "https://localhost:8443", "process"],
      [5432, "service", "db", "http://localhost:5432", "docker"],
      [60123, "internal", "node", "http://localhost:60123", "process"],
    ],
  );
});
