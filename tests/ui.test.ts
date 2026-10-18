import { expect, test } from "bun:test";
import { createUI } from "../src/ui";

test("frame ancestry trusts the separately configured Console origin", async () => {
  const ui = createUI("https://console.example");
  const result = await ui.handle(
    new Request("https://plugin.example/ui/registry"),
  );
  expect(result.status).toBe(200);
  expect(result.headers.get("content-security-policy")).toContain(
    "frame-ancestors https://console.example;",
  );
  expect(result.headers.get("content-security-policy")).not.toContain(
    "https://api.example",
  );
});

test("UI refuses missing, insecure or noncanonical Console origins", () => {
  for (const value of [
    "",
    "http://console.example",
    "https://console.example/",
    "https://console.example/path",
    "https://user:pass@console.example",
    "https://console.example?x=1",
    "https://console.example#x",
    "https://CONSOLE.example",
  ])
    expect(() => createUI(value)).toThrow();
});
