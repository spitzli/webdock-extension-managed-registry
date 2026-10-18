import { Elysia, t } from "elysia";
import { timingSafeEqual } from "node:crypto";
import {
  createPluginContext,
  verifyInvocation,
} from "@webdock/plugin-sdk/server";
import type { PluginHTTP } from "@webdock/plugin-sdk/contracts";
import {
  configurationSchema,
  registryAction,
  registryOrigin,
} from "./registry";
export type RuntimeConfig = {
  credential: string;
  hostOrigin: string;
  publicKey: string;
  generation: number;
};
export function createRuntime(
  config: RuntimeConfig,
  context: (token: string) => { http: PluginHTTP } = (token) =>
    createPluginContext({
      hostURL: config.hostOrigin,
      token: () => token,
      runtimeCredential: config.credential,
    }),
) {
  if (
    config.credential.length < 32 ||
    !config.publicKey ||
    !Number.isSafeInteger(config.generation) ||
    config.generation < 1
  )
    throw Error("Plugin runtime configuration required");
  registryOrigin(config.hostOrigin);
  return new Elysia({ aot: true })
    .get("/healthz", () => ({
      ok: true,
      pluginID: "managed-registry",
      version: "0.1.0-alpha.1",
      generation: config.generation,
      protocolVersion: 1,
    }))
    .post(
      "/actions/:action",
      async ({ request, params, body, status }) => {
        const supplied = Buffer.from(
          request.headers.get("authorization") ?? "",
        );
        const expected = Buffer.from("Bearer " + config.credential);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          return status(401, { error: "Unauthorized runtime" });
        try {
          const token = request.headers.get("x-plugin-invocation") ?? "";
          const claims = verifyInvocation(token, {
            publicKey: config.publicKey,
            pluginID: "managed-registry",
            generation: config.generation,
          });
          if (
            claims.action !== params.action ||
            body.hostOrigin !== config.hostOrigin
          )
            throw Error("Invocation mismatch");
          const configuration = configurationSchema.parse(body.configuration);
          return await registryAction(
            context(token),
            params.action,
            body.input,
            {
              projectID: claims.projectID,
              origin: configuration.registry_origin,
              allowedKindKeys: configuration.allowed_kind_keys,
            },
          );
        } catch {
          return status(400, {
            error:
              "Registry action failed. Check project access, approved kind keys and input values.",
          });
        }
      },
      {
        body: t.Object(
          {
            input: t.Unknown(),
            configuration: t.Object(
              {
                registry_origin: t.String({ maxLength: 200 }),
                allowed_kind_keys: t.Array(t.String({ maxLength: 40 }), {
                  maxItems: 50,
                }),
              },
              { additionalProperties: false },
            ),
            hostOrigin: t.String({ maxLength: 200 }),
          },
          { additionalProperties: false },
        ),
      },
    );
}
