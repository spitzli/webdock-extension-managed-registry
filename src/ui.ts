import { Elysia } from "elysia";
import { readFileSync } from "node:fs";
export function createUI(consoleOrigin: string) {
  const origin = new URL(consoleOrigin);
  if (origin.protocol !== "https:" || origin.origin !== consoleOrigin)
    throw Error(
      "WEBDOCK_PLUGIN_CONSOLE_ORIGIN must be a canonical HTTPS origin",
    );
  const csp = `default-src 'none'; script-src 'self'; style-src 'self'; frame-ancestors ${consoleOrigin}; base-uri 'none'; form-action 'none'; connect-src 'none'`;
  const app = new Elysia();
  for (const [path, file, type] of [
    ["/ui/registry", "registry.html", "text/html"],
    ["/ui/registry.js", "registry.js", "application/javascript"],
    ["/ui/registry.css", "registry.css", "text/css"],
  ]) {
    app.get(
      path,
      () =>
        new Response(readFileSync(new URL("../ui/" + file, import.meta.url)), {
          headers: {
            "content-type": type + "; charset=utf-8",
            "content-security-policy": csp,
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          },
        }),
    );
  }
  return app;
}
