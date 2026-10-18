import { z } from "zod";
import type {
  PluginHTTP,
  PluginHTTPRequest,
} from "@webdock/plugin-sdk/contracts";
const empty = z.strictObject({});
const hex = z
  .string()
  .length(7)
  .regex(/^#[0-9a-fA-F]{6}$/);
const httpsURL = z
  .string()
  .max(500)
  .refine((value) => {
    if (value === "") return true;
    try {
      const u = new URL(value);
      return u.protocol === "https:" && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "Use an HTTPS URL without credentials, or leave empty to clear");
const key = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
export const configurationSchema = z.strictObject({
  registry_origin: z.string().max(200),
  allowed_kind_keys: z.array(key).max(50),
});
const brandingSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(60).optional(),
    tagline: z.string().max(200).optional(),
    primary_hex: hex.optional(),
    accent_hex: hex.optional(),
    success_hex: hex.optional(),
    footer_text: z.string().max(1000).optional(),
    allow_indexing: z.boolean().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "Supply at least one field",
  );
const settingsSchema = z
  .strictObject({
    docs_external_url: httpsURL.optional(),
    require_approval: z.boolean().optional(),
    manifest_require_kind: z.boolean().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "Supply at least one field",
  );
const kindFields = {
  key,
  label: z.string().trim().min(1).max(60),
  description: z.string().max(280).optional(),
  public_page_enabled: z.boolean().optional(),
};
const kindCreate = z.strictObject(kindFields);
const kindUpdate = z.strictObject({
  ...kindFields,
  extensions_schema_json: z.string().max(32768).optional(),
});
const extensionsUpdate = z.strictObject({
  extensions_json: z.string().max(32768),
});
export const actionSchemas = {
  "registry.overview": empty,
  "registry.branding.read": empty,
  "registry.branding.update": brandingSchema,
  "registry.settings.read": empty,
  "registry.settings.update": settingsSchema,
  "registry.kinds.list": empty,
  "registry.kinds.create": kindCreate,
  "registry.kinds.update": kindUpdate,
  "registry.extensions.read": empty,
  "registry.extensions.update": extensionsUpdate,
  "registry.providers.list": empty,
};
export function parseExtensions(value: string): Record<string, unknown> | null {
  if (value === "") return null;
  if (Buffer.byteLength(value, "utf8") > 32768)
    throw Error("Extension JSON is too large");
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw Error("Extension JSON must be an object");
  let nodes = 0;
  function visit(node: unknown, depth: number) {
    if (++nodes > 2500 || depth > 12)
      throw Error("Extension JSON is too complex");
    if (!node || typeof node !== "object") return;
    for (const [name, child] of Object.entries(node)) {
      if (["__proto__", "prototype", "constructor"].includes(name))
        throw Error("Unsafe extension key");
      if (
        ["$ref", "$dynamicRef", "$recursiveRef"].includes(name) &&
        (typeof child !== "string" || !child.startsWith("#/"))
      )
        throw Error("External schema references are not supported");
      visit(child, depth + 1);
    }
  }
  visit(parsed, 0);
  return parsed as Record<string, unknown>;
}
export function registryOrigin(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw Error("Registry must be an HTTPS origin");
  return u.origin;
}
type Scope = {
  projectID: string;
  origin: string;
  allowedKindKeys: readonly string[];
};
type RecordValue = Record<string, any>;
const object = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
function select(value: unknown, fields: readonly string[]) {
  const source = object(value);
  return Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(source, field))
      .map((field) => [field, source[field]]),
  );
}
const providerFields: Record<string, string> = {
  primary_hex: "primaryHex",
  accent_hex: "accentHex",
  success_hex: "successHex",
  footer_text: "footerText",
  allow_indexing: "allowIndexing",
  docs_external_url: "docsExternalUrl",
  require_approval: "requireApproval",
  manifest_require_kind: "manifestRequireKind",
  public_page_enabled: "publicPageEnabled",
};
function providerInput(input: RecordValue) {
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => [
      providerFields[name] ?? name,
      value === "" && ["docs_external_url", "description"].includes(name)
        ? null
        : value,
    ]),
  );
}
const brandFields = [
  "name",
  "tagline",
  "primaryHex",
  "accentHex",
  "successHex",
  "footerText",
  "allowIndexing",
];
const kindViewFields = [
  "key",
  "label",
  "description",
  "publicPageEnabled",
  "extensionsSchema",
];
const kindPreserveFields = [
  ...kindViewFields,
  "labelTranslations",
  "descriptionTranslations",
  "publicPageCopy",
  "prosePre",
  "prosePreTranslations",
  "prosePost",
  "prosePostTranslations",
  "customExample",
];
function settingsView(value: unknown) {
  const v = object(value);
  return {
    ...select(v, ["requireApproval", "docsExternalUrl"]),
    manifest: select(v.manifest, [
      "requireKind",
      "requireKindAvailable",
      "configuredKindKeys",
      "allowedFiles",
    ]),
  };
}
function providersView(value: unknown) {
  const v = object(value);
  if (!Array.isArray(v.instances)) throw Error("Invalid provider response");
  return v.instances.map((instance: unknown) =>
    select(instance, [
      "id",
      "kind",
      "displayName",
      "enabled",
      "hasOAuthSecret",
      "lastUsedAt",
    ]),
  );
}
export async function registryAction(
  ctx: { http: PluginHTTP },
  action: string,
  input: unknown,
  scope: Scope,
): Promise<any> {
  if (!scope.projectID) throw Error("Project required");
  const origin = registryOrigin(scope.origin);
  const allowed = configurationSchema.shape.allowed_kind_keys.parse(
    scope.allowedKindKeys,
  );
  if (!Object.hasOwn(actionSchemas, action))
    throw Error("Unknown registry action");
  const schema = actionSchemas[action as keyof typeof actionSchemas];
  const data = schema.parse(input) as RecordValue;
  async function request(
    method: PluginHTTPRequest["method"],
    path: string,
    body?: unknown,
  ) {
    const response = await ctx.http.request({
      binding: "registry",
      method,
      path,
      ...(body === undefined ? {} : { body }),
    });
    if (response.status < 200 || response.status >= 300)
      throw Error(`Registry request failed (${response.status})`);
    return object(response.body);
  }
  const getBranding = async () =>
    select((await request("GET", "/api/admin/branding")).current, brandFields);
  const getSettings = async () =>
    settingsView(await request("GET", "/api/admin/instance"));
  const getKinds = async () => {
    const result = await request("GET", "/api/admin/kinds");
    if (!Array.isArray(result.kinds)) throw Error("Invalid kind response");
    return result.kinds as RecordValue[];
  };
  const getProviders = async () =>
    providersView(await request("GET", "/api/admin/provider-instances"));
  switch (action) {
    case "registry.overview": {
      const branding = await getBranding();
      const settings = await getSettings();
      const kinds = await getKinds();
      const providers = await getProviders();
      return {
        origin,
        branding,
        settings,
        kindCount: kinds.length,
        providerCount: providers.length,
        readyProviderCount: providers.filter(
          (v) => v.enabled === true && v.hasOAuthSecret === true,
        ).length,
      };
    }
    case "registry.branding.read":
      return await getBranding();
    case "registry.branding.update":
      return select(
        (await request("PUT", "/api/admin/branding", providerInput(data)))
          .branding,
        brandFields,
      );
    case "registry.settings.read":
      return await getSettings();
    case "registry.settings.update":
      await request("PUT", "/api/admin/instance", providerInput(data));
      return { ok: true };
    case "registry.kinds.list":
      return {
        kinds: (await getKinds()).map((kind) => ({
          ...select(kind, kindViewFields),
          editable: allowed.includes(kind.key),
        })),
        allowedKindKeys: allowed,
      };
    case "registry.kinds.create":
    case "registry.kinds.update": {
      if (!allowed.includes(data.key))
        throw Error("Kind key must be approved by the operator");
      if (action === "registry.kinds.create")
        return {
          kind: select(
            (await request("POST", "/api/admin/kinds", providerInput(data)))
              .kind,
            kindViewFields,
          ),
        };
      const { extensions_schema_json, ...patch } = data;
      const extensions =
        extensions_schema_json === undefined
          ? undefined
          : parseExtensions(extensions_schema_json);
      const current = (await getKinds()).find((kind) => kind.key === data.key);
      if (!current) throw Error("Kind does not exist");
      // Upstream PUT replaces the entire kind; preserve operator-owned copy and translations.
      const body = {
        ...select(current, kindPreserveFields),
        ...providerInput(patch),
        ...(extensions === undefined ? {} : { extensionsSchema: extensions }),
      };
      return {
        kind: select(
          (await request("PUT", `/api/admin/kinds/${data.key}`, body)).kind,
          kindViewFields,
        ),
      };
    }
    case "registry.extensions.read": {
      const result = await request("GET", "/api/admin/manifest/extensions");
      return { extensions: object(result.extensions) };
    }
    case "registry.extensions.update":
      await request("PUT", "/api/admin/manifest/extensions", {
        extensions: parseExtensions(data.extensions_json),
      });
      return { ok: true };
    case "registry.providers.list":
      return { providers: await getProviders() };
  }
}
