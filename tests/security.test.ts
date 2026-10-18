import { describe, expect, test } from "bun:test";
import { registryAction, parseExtensions } from "../src/registry";
import manifest from "../tabularium.json";
const scope = {
  projectID: "project-a",
  origin: "https://registry.example",
  allowedKindKeys: ["extension"],
};
function fixture(responses: unknown[] = []) {
  const requests: any[] = [];
  return {
    requests,
    http: {
      async request(request: any) {
        requests.push(request);
        return { status: 200, body: responses.shift() ?? { ok: true } };
      },
    },
  };
}
describe("registry trust boundaries", () => {
  test("blocks tenant selectors, script branding, and insecure configuration before HTTP", async () => {
    for (const [action, input, s] of [
      [
        "registry.branding.update",
        { name: "A", analyticsScript: "alert(1)" },
        scope,
      ],
      ["registry.overview", { projectID: "other" }, scope],
      [
        "registry.settings.update",
        { docs_external_url: "http://example.com" },
        scope,
      ],
      [
        "registry.overview",
        {},
        { ...scope, origin: "https://registry.example/admin" },
      ],
      [
        "registry.overview",
        {},
        { ...scope, origin: "http://registry.example" },
      ],
    ] as const) {
      const ctx = fixture();
      await expect(registryAction(ctx, action, input, s)).rejects.toThrow();
      expect(ctx.requests).toHaveLength(0);
    }
  });
  test("kind writes reject unapproved and traversal keys before HTTP", async () => {
    for (const key of ["other", "../instance", "extension?admin=1"]) {
      const ctx = fixture();
      await expect(
        registryAction(
          ctx,
          "registry.kinds.update",
          { key, label: "Test" },
          scope,
        ),
      ).rejects.toThrow();
      expect(ctx.requests).toHaveLength(0);
    }
  });
  test("strips scripts and provider credentials from overview", async () => {
    const ctx = fixture([
      {
        current: {
          name: "Registry",
          tagline: "Tools",
          primaryHex: "#123456",
          analyticsScript: "secret script",
        },
      },
      {
        requireApproval: true,
        docsExternalUrl: null,
        rateLimits: [{ secret: "private" }],
        manifest: { requireKind: true },
      },
      {
        kinds: [
          {
            key: "extension",
            label: "Extensions",
            description: null,
            prosePre: "private",
          },
        ],
      },
      {
        instances: [
          {
            id: "github",
            kind: "github",
            displayName: "GitHub",
            baseUrl: "https://github.com",
            enabled: true,
            hasOAuthSecret: true,
            clientSecret: "token",
            clientId: "id",
          },
        ],
      },
    ]);
    const result = await registryAction(ctx, "registry.overview", {}, scope);
    expect(result).toMatchObject({
      branding: { name: "Registry" },
      kindCount: 1,
      providerCount: 1,
      readyProviderCount: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /secret script|clientSecret|clientId|rateLimits|private/,
    );
  });
  test("kind edits preserve prose, translations, schema and description omitted from input", async () => {
    const old = {
      key: "extension",
      label: "Old",
      description: "Keep me",
      labelTranslations: { de: "Erweiterung" },
      prosePre: "Keep this",
      customExample: { yaml: "key: value" },
      extensionsSchema: { topic: { type: "string" } },
      publicPageEnabled: true,
    };
    const ctx = fixture([{ kinds: [old] }, { kind: { ...old, label: "New" } }]);
    await registryAction(
      ctx,
      "registry.kinds.update",
      { key: "extension", label: "New" },
      scope,
    );
    expect(ctx.requests[1]).toMatchObject({
      binding: "registry",
      method: "PUT",
      path: "/api/admin/kinds/extension",
      body: { ...old, label: "New" },
    });
  });
  test("upstream errors never disclose response or credential fields", async () => {
    await expect(
      registryAction(
        {
          http: {
            async request() {
              return { status: 403, body: { error: "secret-token" } };
            },
          },
        },
        "registry.branding.read",
        {},
        scope,
      ),
    ).rejects.toThrow("Registry request failed (403)");
  });
  test("declared kind-update capabilities authorize the preservation read and write", async () => {
    const capabilities = manifest.actions.find(
      (action) => action.name === "registry.kinds.update",
    )!.capabilities;
    const ctx = {
      http: {
        async request(request: any) {
          if (
            !capabilities.includes(
              request.method === "GET"
                ? "plugin.http.read"
                : "plugin.http.request",
            )
          )
            throw Error("Host capability denied");
          return {
            status: 200,
            body:
              request.method === "GET"
                ? {
                    kinds: [
                      { key: "extension", label: "Old", description: "Keep" },
                    ],
                  }
                : { kind: request.body },
          };
        },
      },
    };
    expect(
      await registryAction(
        ctx,
        "registry.kinds.update",
        { key: "extension", label: "Updated" },
        scope,
      ),
    ).toEqual({
      kind: { key: "extension", label: "Updated", description: "Keep" },
    });
  });
});
describe("extension JSON", () => {
  test("accepts an object delta and explicit clearing", () => {
    expect(parseExtensions('{"topic":{"type":"string"}}')).toEqual({
      topic: { type: "string" },
    });
    expect(parseExtensions("")).toBeNull();
  });
  test("rejects external references, unsafe keys and bounded complexity", () => {
    for (const value of [
      "[]",
      "true",
      '{"topic":{"$ref":"https://evil.example/schema"}}',
      '{"__proto__":{"type":"string"}}',
      '{"x":{"constructor":{}}}',
      JSON.stringify({ x: "a".repeat(33000) }),
      '{"x":'.repeat(20) + "{}" + "}".repeat(20),
    ])
      expect(() => parseExtensions(value)).toThrow();
  });
});

test("kind keys accept upstream numeric prefixes but reject underscores", async () => {
  const ctx = fixture([
    { kind: { key: "1-theme", label: "Numeric prefix", description: null } },
  ]);
  expect(
    await registryAction(
      ctx,
      "registry.kinds.create",
      { key: "1-theme", label: "Numeric prefix" },
      { ...scope, allowedKindKeys: ["1-theme"] },
    ),
  ).toMatchObject({ kind: { key: "1-theme" } });
  const blocked = fixture();
  await expect(
    registryAction(
      blocked,
      "registry.kinds.create",
      { key: "my_theme", label: "Invalid" },
      { ...scope, allowedKindKeys: ["my_theme"] },
    ),
  ).rejects.toThrow();
  expect(blocked.requests).toHaveLength(0);
});

test("snake-case inputs map to only the provider fields and support explicit clearing", async () => {
  const branding = fixture([{ branding: { name: "Registry" } }]);
  await registryAction(
    branding,
    "registry.branding.update",
    { primary_hex: "#123456", footer_text: "", allow_indexing: false },
    scope,
  );
  expect(branding.requests[0].body).toEqual({
    primaryHex: "#123456",
    footerText: "",
    allowIndexing: false,
  });
  const settings = fixture();
  await registryAction(
    settings,
    "registry.settings.update",
    {
      docs_external_url: "",
      require_approval: true,
      manifest_require_kind: false,
    },
    scope,
  );
  expect(settings.requests[0].body).toEqual({
    docsExternalUrl: null,
    requireApproval: true,
    manifestRequireKind: false,
  });
  const extensions = fixture();
  await registryAction(
    extensions,
    "registry.extensions.update",
    { extensions_json: "" },
    scope,
  );
  expect(extensions.requests[0].body).toEqual({ extensions: null });
  for (const [action, input] of [
    ["registry.branding.update", { primaryHex: "#123456" }],
    ["registry.settings.update", { docs_external_url: null }],
    ["registry.extensions.update", { extensions_json: null }],
  ] as const)
    await expect(
      registryAction(fixture(), action, input, scope),
    ).rejects.toThrow();
});
