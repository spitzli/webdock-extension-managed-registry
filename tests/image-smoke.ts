import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
const image =
  process.env.PLUGIN_TEST_IMAGE ?? "webdock-managed-registry:0.1.0-alpha.1";
const dir = await mkdtemp(join(tmpdir(), "registry-image-")),
  name = "webdock-registry-image-" + randomBytes(6).toString("hex");
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  }).trim();
let started = false;
try {
  const publicKey = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  const cert = join(dir, "cert.pem"),
    key = join(dir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  await chmod(key, 0o644);
  await writeFile(
    join(dir, "runtime.env"),
    `WEBDOCK_PLUGIN_RUNTIME_TOKEN=${randomBytes(32).toString("hex")}\nWEBDOCK_PLUGIN_HOST_URL=https://callback.example.test\nWEBDOCK_PLUGIN_CONSOLE_ORIGIN=https://console.example.test\nWEBDOCK_PLUGIN_HOST_PUBLIC_KEY=${Buffer.from(publicKey).toString("base64")}\nWEBDOCK_PLUGIN_GENERATION=1\nWEBDOCK_PLUGIN_TLS_CERT=/run/tls/cert.pem\nWEBDOCK_PLUGIN_TLS_KEY=/run/tls/key.pem\n`,
    { mode: 0o600 },
  );
  // Host public key PEM can contain newlines, which env files cannot encode. A readonly PEM file supplies the launch wrapper.
  await writeFile(join(dir, "host.pem"), publicKey, { mode: 0o644 });
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "webdock.registry-image=" + name,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--network",
    "bridge",
    "--env-file",
    join(dir, "runtime.env"),
    "-v",
    dir + ":/run/tls:ro",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=16m",
    "-p",
    "127.0.0.1::3443",
    "-p",
    "127.0.0.1::3444",
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    'export WEBDOCK_PLUGIN_HOST_PUBLIC_KEY="$(cat /run/tls/host.pem)"; exec bun src/index.ts',
  );
  started = true;
  const tlsPort = docker("port", name, "3443/tcp").split(":").at(-1),
    ui = "http://" + docker("port", name, "3444/tcp");
  let ready = false;
  for (let n = 0; n < 60; n++) {
    try {
      if ((await fetch(ui + "/ui/registry")).status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await Bun.sleep(200);
  }
  assert.ok(ready, "Image starts as non-root with read-only filesystem");
  const html = await fetch(ui + "/ui/registry");
  assert.equal(html.status, 200);
  assert.match(
    html.headers.get("content-security-policy")!,
    /frame-ancestors https:\/\/console.example.test;/,
  );
  assert.equal(
    (await fetch(ui + "/actions/registry.overview", { method: "POST" })).status,
    404,
  );
  const health = execFileSync(
    "curl",
    [
      "--silent",
      "--show-error",
      "--fail",
      "--cacert",
      cert,
      `https://localhost:${tlsPort}/healthz`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(JSON.parse(health).pluginID, "managed-registry");
  assert.equal(JSON.parse(health).version, "0.1.0-alpha.1");
  assert.notEqual(
    docker("inspect", "--format", "{{.Config.User}}", name),
    "root",
  );
  console.log(
    JSON.stringify({
      passed: true,
      image,
      checks: [
        "non-root read-only image",
        "private HTTPS verified certificate",
        "health identity/version",
        "public UI cannot invoke actions",
        "separate Console CSP",
      ],
    }),
  );
} finally {
  if (started) {
    assert.equal(
      docker(
        "inspect",
        "--format",
        '{{index .Config.Labels "webdock.registry-image"}}',
        name,
      ),
      name,
    );
    docker("rm", "-f", name);
  }
  await rm(dir, { recursive: true, force: true });
}
