/** Local authoring harness: actual plugin runtime + disposable PostgreSQL-backed Tabularium. */
import { randomBytes, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRuntime } from "../src/runtime";
import { startProviderFixture } from "./provider-fixture";
import manifest from "../tabularium.json";
const fixture = await startProviderFixture();
const origin = "http://127.0.0.1:3480",
  uiOrigin = "http://127.0.0.1:3481";
const key = generateKeyPairSync("ed25519"),
  credential = randomBytes(32).toString("hex"),
  csrf = randomBytes(32).toString("hex");
const runtimeOrigin = "https://callback.fixture.test";
const runtime = createRuntime(
  {
    credential,
    hostOrigin: runtimeOrigin,
    publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
    generation: 1,
  },
  (token) => ({
    http: {
      request: async (input) => {
        const claims = JSON.parse(
          Buffer.from(token.split(".")[0], "base64url").toString(),
        );
        const action = manifest.actions.find(
          (action) => action.name === claims.action,
        );
        if (
          !action?.capabilities.includes(
            input.method === "GET" ? "plugin.http.read" : "plugin.http.request",
          )
        )
          throw Error("Action capability denied");
        const allowed = [
          "/api/admin/branding",
          "/api/admin/instance",
          "/api/admin/kinds",
          "/api/admin/kinds/extension",
          "/api/admin/kinds/theme",
          "/api/admin/manifest/extensions",
          "/api/admin/provider-instances",
        ];
        if (input.binding !== "registry" || !allowed.includes(input.path))
          throw Error("Binding path denied");
        return fixture.raw(input.path, input.method, input.body);
      },
    },
  }),
);
await fixture.admin("/api/admin/branding", "PUT", {
  name: "Harbor Registry",
  tagline: "A home for the extensions your team builds.",
  primaryHex: "#486bff",
  accentHex: "#2dd4bf",
  footerText: "Built and maintained by the Harbor team",
});
await fixture.admin("/api/admin/instance", "PUT", {
  docsExternalUrl: "https://docs.example.test",
  requireApproval: true,
});
await fixture.admin("/api/admin/kinds", "POST", {
  key: "extension",
  label: "Extensions",
  description: "Deployable extensions for your workspace.",
  publicPageEnabled: true,
});
await fixture.admin("/api/admin/kinds", "POST", {
  key: "theme",
  label: "Themes",
  description: "Design systems and color palettes.",
  publicPageEnabled: true,
});
await fixture.admin("/api/admin/instance", "PUT", {
  manifestRequireKind: true,
});
const ui = Bun.serve({
  hostname: "127.0.0.1",
  port: 3481,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.host !== "127.0.0.1:3481" || req.method !== "GET")
      return new Response("Denied", { status: 403 });
    const files: Record<string, [string, string]> = {
      "/ui/registry": ["registry.html", "text/html"],
      "/ui/registry.js": ["registry.js", "application/javascript"],
      "/ui/registry.css": ["registry.css", "text/css"],
    };
    const entry = files[url.pathname];
    if (!entry) return new Response("Not found", { status: 404 });
    return new Response(
      await readFile(new URL("../ui/" + entry[0], import.meta.url)),
      {
        headers: {
          "Content-Type": entry[1],
          "Cache-Control": "no-store",
          "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self'; frame-ancestors ${origin}; base-uri 'none'; connect-src 'none'`,
        },
      },
    );
  },
});
const events: Array<{ action: string; status: number }> = [];
const host = Bun.serve({
  hostname: "127.0.0.1",
  port: 3480,
  maxRequestBodySize: 65536,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.host !== "127.0.0.1:3480")
      return new Response("Denied", { status: 403 });
    if (req.method === "GET" && url.pathname === "/proof")
      return Response.json({
        events,
        branding: (await fixture.raw("/api/admin/branding")).body.current.name,
      });
    if (req.method === "GET" && url.pathname === "/")
      return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Managed Registry · Local acceptance</title><style>body{margin:0;background:#0b1421;color:#bbcae1;font:12px system-ui}header{height:38px;display:flex;align-items:center;padding:0 22px;border-bottom:1px solid #29354b}iframe{display:block;border:0;width:100vw;height:calc(100vh - 39px)}</style><header>Local authoring preview · Disposable PostgreSQL-backed Tabularium · Fictional Harbor project</header><iframe title="Managed Registry" sandbox="allow-scripts" src="${uiOrigin}/ui/registry#${csrf}"></iframe><script>const frame=document.querySelector('iframe');frame.onload=()=>{const channel=new MessageChannel();channel.port1.onmessage=async event=>{const {id,name,input}=event.data;try{const response=await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json','X-Preview-Key':'${csrf}'},body:JSON.stringify({name,input})});const result=await response.json();channel.port1.postMessage(response.ok?{id,result}:{id,error:'Registry action failed'});}catch{channel.port1.postMessage({id,error:'Registry action failed'});}};frame.contentWindow.postMessage({type:'webdock:init',nonce:'${csrf}'},'*',[channel.port2]);};</script></html>`,
        {
          headers: {
            "Content-Type": "text/html",
            "Cache-Control": "no-store",
            "Content-Security-Policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${uiOrigin}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
          },
        },
      );
    if (
      req.method !== "POST" ||
      url.pathname !== "/action" ||
      req.headers.get("origin") !== origin ||
      req.headers.get("x-preview-key") !== csrf
    )
      return new Response("Denied", { status: 403 });
    try {
      const { name, input } = (await req.json()) as {
        name: string;
        input: unknown;
      };
      const payload = Buffer.from(
        JSON.stringify({
          v: 1,
          id: crypto.randomUUID(),
          pluginID: "managed-registry",
          generation: 1,
          projectID: "980000000000000001",
          action: name,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 60,
        }),
      ).toString("base64url");
      const invocation =
        payload +
        "." +
        sign(null, Buffer.from(payload), key.privateKey).toString("base64url");
      const response = await runtime.handle(
        new Request("https://runtime.fixture.test/actions/" + name, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + credential,
            "X-Plugin-Invocation": invocation,
          },
          body: JSON.stringify({
            input,
            configuration: {
              registry_origin: "https://registry.example.test",
              allowed_kind_keys: ["extension", "theme"],
            },
            hostOrigin: runtimeOrigin,
          }),
        }),
      );
      events.push({ action: name, status: response.status });
      return response;
    } catch {
      return Response.json({ error: "Preview action failed" }, { status: 400 });
    }
  },
});
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await host.stop(true);
  await ui.stop(true);
  await fixture.cleanup();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
console.log(JSON.stringify({ ready: true, url: origin }));
