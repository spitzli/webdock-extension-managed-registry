/** Opt-in real-provider acceptance: all changes are confined to freshly created local Docker resources. */
import assert from "node:assert/strict";
import { registryAction } from "../src/registry";
import { startProviderFixture, providerImage } from "./provider-fixture";
const fixture = await startProviderFixture();
const scope = {
  projectID: "980000000000000001",
  origin: "https://registry.example.test",
  allowedKindKeys: ["extension", "theme"],
};
const paths = new Set([
  "/api/admin/branding",
  "/api/admin/instance",
  "/api/admin/kinds",
  "/api/admin/kinds/extension",
  "/api/admin/kinds/theme",
  "/api/admin/manifest/extensions",
  "/api/admin/provider-instances",
]);
const ctx = {
  http: {
    request: async (input: any) => {
      assert.equal(input.binding, "registry");
      assert.ok(paths.has(input.path));
      return fixture.raw(input.path, input.method, input.body);
    },
  },
};
const call = (action: string, input: unknown = {}) =>
  registryAction(ctx, action, input, scope);
try {
  const initial = await call("registry.overview");
  assert.equal(initial.origin, scope.origin);
  assert.equal(
    (
      await fixture.raw("/api/admin/tokens", "POST", {
        name: "forbidden",
        scopes: null,
      })
    ).status,
    403,
    "Provider token must not mint full-admin credentials",
  );
  await fixture.admin("/api/admin/branding", "PUT", {
    name: "Harbor Registry",
    tagline: "Ship extensions with confidence.",
    taglineTranslations: { de: "Erweiterungen sicher veröffentlichen." },
    footerText: "Maintained by the Harbor team",
    primaryHex: "#059669",
  });
  const branded = await call("registry.branding.update", {
    name: "Harbor Registry",
    tagline: "A home for your extensions.",
    accent_hex: "#26bfa5",
  });
  assert.equal(branded.name, "Harbor Registry");
  assert.equal(branded.accentHex, "#26bfa5");
  const fullBrand = (await fixture.admin("/api/admin/branding")).body.current;
  assert.equal(
    fullBrand.taglineTranslations.de,
    "Erweiterungen sicher veröffentlichen.",
  );
  assert.ok(!Object.hasOwn(branded, "analyticsScript"));
  const existing = await call("registry.kinds.list");
  if (!existing.kinds.some((k: any) => k.key === "extension"))
    await call("registry.kinds.create", {
      key: "extension",
      label: "Extensions",
      description: "Deployable extensions",
    });
  const current = (await fixture.admin("/api/admin/kinds/extension")).body.kind;
  await fixture.admin("/api/admin/kinds/extension", "PUT", {
    ...current,
    labelTranslations: { de: "Erweiterungen" },
    prosePre: "Publisher guide",
    customExample: { json: '{"kind":"extension"}' },
  });
  const kind = await call("registry.kinds.update", {
    key: "extension",
    label: "Extensions",
    extensions_schema_json: '{"runtime":{"type":"string"}}',
  });
  assert.equal(kind.kind.extensionsSchema.runtime.type, "string");
  const saved = (await fixture.admin("/api/admin/kinds/extension")).body.kind;
  assert.equal(saved.labelTranslations.de, "Erweiterungen");
  assert.equal(saved.prosePre, "Publisher guide");
  assert.equal(saved.description, current.description);
  assert.deepEqual(saved.customExample, { json: '{"kind":"extension"}' });
  await call("registry.settings.update", {
    docs_external_url: "https://docs.example.test",
    require_approval: true,
    manifest_require_kind: true,
  });
  const settings = await call("registry.settings.read");
  assert.equal(settings.docsExternalUrl, "https://docs.example.test");
  assert.equal(settings.manifest.requireKind, true);
  await call("registry.extensions.update", {
    extensions_json: '{"compatibility":{"type":"string"}}',
  });
  assert.equal(
    (await call("registry.extensions.read")).extensions.compatibility.type,
    "string",
  );
  await call("registry.extensions.update", { extensions_json: "" });
  assert.deepEqual((await call("registry.extensions.read")).extensions, {});
  assert.ok(Array.isArray((await call("registry.providers.list")).providers));
  await assert.rejects(() =>
    call("registry.kinds.create", { key: "unapproved", label: "No" }),
  );
  await assert.rejects(() =>
    call("registry.branding.update", {
      analyticsScript: "<script>alert(1)</script>",
    }),
  );
  await assert.rejects(() =>
    call("registry.extensions.update", {
      extensions_json: '{"a":{"$ref":"https://evil.test/schema"}}',
    }),
  );
  console.log(
    JSON.stringify({
      passed: true,
      providerImage,
      database: "PostgreSQL 18",
      actions: 11,
      checks: [
        "real bootstrap and login",
        "scoped token cannot issue tokens",
        "branding preserves translations",
        "kind updates preserve unexposed fields",
        "docs URL and required kind",
        "manifest delta set and clear",
        "provider readiness",
        "unapproved kind and script rejection",
      ],
    }),
  );
} finally {
  await fixture.cleanup();
}
