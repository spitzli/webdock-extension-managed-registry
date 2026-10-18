/** Disposable local PostgreSQL + the released Tabularium image. Never reads production env. */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const providerImage =
  "ghcr.io/tabularisdb/tabularium@sha256:3384ebd98e74f704b31653d921ad872f94936e29ad3fef6c0281519ad9304cf3";
export const providerScopes = [
  "admin:branding:read",
  "admin:branding:write",
  "admin:instance:read",
  "admin:instance:write",
  "admin:kinds:read",
  "admin:kinds:write",
  "admin:manifest:read",
  "admin:manifest:write",
  "admin:provider-instances:read",
];
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  }).trim();
export async function startProviderFixture() {
  const name = "webdock-registry-test-" + randomBytes(5).toString("hex"),
    dir = await mkdtemp(join(tmpdir(), name + "-"));
  const password = randomBytes(32).toString("base64url");
  let origin = "",
    cookie = "",
    token = "";
  const resources: string[] = [];
  const cleanup = async () => {
    for (const id of resources.reverse()) {
      const label = docker(
        "inspect",
        "--format",
        '{{index .Config.Labels "webdock.registry-fixture"}}',
        id,
      );
      if (label !== name) throw Error("Refusing unowned fixture cleanup");
      docker("rm", "-f", "-v", id);
    }
    try {
      docker("network", "rm", name);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  try {
    docker(
      "network",
      "create",
      "--label",
      "webdock.registry-fixture=" + name,
      name,
    );
    await writeFile(
      join(dir, "postgres.env"),
      `POSTGRES_USER=registry_fixture\nPOSTGRES_DB=registry_fixture\nPOSTGRES_PASSWORD=${password}\n`,
      { mode: 0o600 },
    );
    resources.push(
      docker(
        "run",
        "-d",
        "--name",
        name + "-db",
        "--label",
        "webdock.registry-fixture=" + name,
        "--network",
        name,
        "--env-file",
        join(dir, "postgres.env"),
        "postgres:18-alpine",
      ),
    );
    for (let n = 0; ; n++) {
      try {
        docker(
          "exec",
          name + "-db",
          "pg_isready",
          "-U",
          "registry_fixture",
          "-d",
          "registry_fixture",
        );
        break;
      } catch {
        if (n > 80) throw Error("PostgreSQL fixture startup failed");
        await Bun.sleep(250);
      }
    }
    await writeFile(
      join(dir, "registry.env"),
      `JWT_SECRET=${randomBytes(32).toString("hex")}\nTOKEN_ENC_KEY=${randomBytes(32).toString("hex")}\nBOOTSTRAP_PASSWORD=${password}\nBASE_URL=http://127.0.0.1:3480\nNODE_ENV=production\nLOG_LEVEL=error\n`,
      { mode: 0o600 },
    );
    resources.push(
      docker(
        "run",
        "-d",
        "--name",
        name + "-app",
        "--label",
        "webdock.registry-fixture=" + name,
        "--network",
        name,
        "--env-file",
        join(dir, "registry.env"),
        "-p",
        "127.0.0.1::3000",
        providerImage,
      ),
    );
    origin = "http://" + docker("port", name + "-app", "3000/tcp");
    const ready = async () => {
      for (let n = 0; n < 100; n++) {
        try {
          const r = await fetch(origin + "/healthz", {
            signal: AbortSignal.timeout(1000),
          });
          if (r.ok) return;
        } catch {}
        await Bun.sleep(200);
      }
      throw Error(
        "Tabularium fixture startup failed: " +
          String(
            spawnSync("docker", ["logs", "--tail", "8", name + "-app"], {
              encoding: "utf8",
            }).stderr,
          ).replaceAll(password, "[redacted]"),
      );
    };
    await ready();
    const raw = async (
      path: string,
      method = "GET",
      body?: unknown,
      credential = cookie,
    ) => {
      const r = await fetch(origin + path, {
        method,
        headers: {
          ...(credential ? { Authorization: "Bearer " + credential } : {}),
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      const text = await r.text();
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        if (!r.ok) value = { error: "Provider rejected request" };
        else
          throw Error(
            "Provider returned non-JSON response at " +
              path +
              " (" +
              r.status +
              ")",
          );
      }
      const session = r.headers
        .get("set-cookie")
        ?.match(/(?:^|,\s*)auth=([^;]+)/)?.[1];
      if (session) cookie = session;
      return { status: r.status, body: value };
    };
    if (
      (
        await raw(
          "/api/init/login",
          "POST",
          { email: "admin@example.com", password },
          "",
        )
      ).status !== 200
    )
      throw Error("Bootstrap login failed");
    const init = await raw("/api/init/complete", "POST", {
      database: {
        url: `postgresql://registry_fixture:${password}@${name}-db:5432/registry_fixture`,
      },
    });
    if (init.status !== 200)
      throw Error("Bootstrap completion failed (" + init.status + ")");
    await Bun.sleep(800);
    docker("start", name + "-app");
    origin = "http://" + docker("port", name + "-app", "3000/tcp");
    await ready();
    if (
      (
        await raw(
          "/auth/email/login",
          "POST",
          { email: "admin@example.com", password },
          "",
        )
      ).status !== 200
    )
      throw Error("Actual provider login failed");
    const issued = await raw("/api/admin/tokens", "POST", {
      name: "Managed registry local acceptance",
      scopes: providerScopes,
    });
    if (issued.status !== 200 || typeof issued.body.token !== "string")
      throw Error("Scoped provider token issuance failed");
    token = issued.body.token;
    return {
      origin,
      raw: (path: string, method = "GET", body?: unknown) =>
        raw(path, method, body, token),
      admin: (path: string, method = "GET", body?: unknown) =>
        raw(path, method, body, cookie),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
