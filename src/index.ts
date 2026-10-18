import { readFileSync } from "node:fs";
import { createRuntime } from "./runtime";
import { createUI } from "./ui";
const credential = process.env.WEBDOCK_PLUGIN_RUNTIME_TOKEN;
const hostOrigin = process.env.WEBDOCK_PLUGIN_HOST_URL;
const consoleOrigin = process.env.WEBDOCK_PLUGIN_CONSOLE_ORIGIN;
const publicKey = process.env.WEBDOCK_PLUGIN_HOST_PUBLIC_KEY;
const generation = Number(process.env.WEBDOCK_PLUGIN_GENERATION);
if (!credential || !hostOrigin || !publicKey || !consoleOrigin)
  throw Error("Plugin runtime configuration required");
const cert = process.env.WEBDOCK_PLUGIN_TLS_CERT;
const key = process.env.WEBDOCK_PLUGIN_TLS_KEY;
if (!cert || !key) throw Error("Private runtime TLS certificate required");
const ui = createUI(consoleOrigin);
createRuntime({ credential, hostOrigin, publicKey, generation }).listen({
  hostname: "0.0.0.0",
  port: 3443,
  tls: { cert: readFileSync(cert), key: readFileSync(key) },
  maxRequestBodySize: 65536,
});
ui.listen({ hostname: "0.0.0.0", port: 3444, maxRequestBodySize: 1024 });
