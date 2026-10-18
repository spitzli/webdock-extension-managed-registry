import { expect, test } from "bun:test";
import { parsePluginManifest } from "@webdock/plugin-sdk/contracts";
import manifest from "../tabularium.json";

test("published manifest conforms to the actual host SDK contract", () => {
  expect(() => parsePluginManifest(manifest)).not.toThrow();
});
