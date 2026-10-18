"use strict";
const el = (id) => document.getElementById(id);
const nonce = location.hash.slice(1);
const pending = new Map();
let port;
let kinds = [];
let allowed = [];
let editing = false;
const titles = {
  overview: "Overview",
  branding: "Branding",
  settings: "Settings",
  kinds: "Plugin kinds",
  extensions: "Manifest fields",
  providers: "Sign-in providers",
};
function status(message, error = false) {
  el("status").textContent = message;
  el("status").classList.toggle("error", error);
}
function call(name, input = {}) {
  return new Promise((resolve, reject) => {
    if (!port)
      return reject(Error("Open this registry from your Webdock project."));
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(
        Error(
          "Request timed out. Refresh to check whether your change was saved.",
        ),
      );
    }, 30000);
    pending.set(id, { resolve, reject, timeout });
    port.postMessage({ type: "action", id, name, input });
  });
}
function page(id) {
  for (const name of Object.keys(titles)) el(name).hidden = name !== id;
  el("page-title").textContent = titles[id];
  for (const button of document.querySelectorAll("[data-page]")) {
    const active = button.dataset.page === id;
    button.classList.toggle("selected", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}
for (const button of document.querySelectorAll("[data-page],[data-go]"))
  button.addEventListener("click", () =>
    page(button.dataset.page || button.dataset.go),
  );
function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}
function fill(form, values) {
  for (const [name, value] of Object.entries(values)) {
    const field = form.elements.namedItem(name);
    if (!field) continue;
    if (field.type === "checkbox") field.checked = value === true;
    else field.value = value ?? "";
  }
}
function renderOverview(data) {
  el("registry-name").textContent = data.branding.name || "Your registry";
  el("registry-tagline").textContent =
    data.branding.tagline || "Your dedicated plugin catalog";
  el("identity-summary").textContent = data.branding.name || "Not configured";
  el("kind-count").textContent = String(data.kindCount);
  el("provider-count").textContent = String(data.readyProviderCount);
  el("provider-summary").textContent =
    `${data.providerCount} configured ${data.providerCount === 1 ? "provider" : "providers"}`;
  el("approval-state").textContent = data.settings.requireApproval
    ? "Review required"
    : "Open";
  el("manifest-summary").textContent = data.settings.manifest?.requireKind
    ? "Required"
    : "Optional";
  const link = el("registry-origin");
  const url = new URL(data.origin);
  if (url.protocol === "https:" && !url.username && !url.password) {
    link.href = url.origin;
    link.textContent = url.hostname;
  }
  fill(el("branding-form"), {
    ...data.branding,
    primary_hex: data.branding.primaryHex,
    accent_hex: data.branding.accentHex,
    success_hex: data.branding.successHex,
    footer_text: data.branding.footerText,
    allow_indexing: data.branding.allowIndexing,
  });
  fill(el("settings-form"), {
    docs_external_url: data.settings.docsExternalUrl,
    require_approval: data.settings.requireApproval,
    manifest_require_kind: data.settings.manifest?.requireKind === true,
  });
}
function resetKind(kind) {
  editing = Boolean(kind);
  const form = el("kind-form");
  form.reset();
  const select = form.elements.namedItem("key");
  select.replaceChildren();
  const keys = kind
    ? [kind.key]
    : allowed.filter((key) => !kinds.some((item) => item.key === key));
  for (const key of keys) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = key;
    select.append(option);
  }
  select.disabled = editing || !keys.length;
  form.querySelector("[data-save]").disabled = !keys.length;
  el("kind-form-title").textContent = kind
    ? "Edit " + kind.label
    : "Create a kind";
  el("kind-schema-wrap").hidden = !kind;
  if (kind)
    fill(form, {
      ...kind,
      public_page_enabled: kind.publicPageEnabled,
      extensions_schema_json: JSON.stringify(
        kind.extensionsSchema || {},
        null,
        2,
      ),
    });
}
function renderKinds(data) {
  kinds = data.kinds;
  allowed = data.allowedKindKeys;
  const list = el("kind-list");
  list.replaceChildren();
  if (!kinds.length)
    list.append(
      text(
        "p",
        "No kinds configured. Create a kind using an operator-approved key.",
        "empty",
      ),
    );
  for (const kind of kinds) {
    const row = document.createElement("div");
    row.className = "kind-row";
    const copy = document.createElement("div");
    copy.append(text("strong", kind.label), text("code", kind.key));
    if (kind.description) copy.append(text("p", kind.description));
    row.append(copy);
    if (kind.editable) {
      const button = text("button", "Edit");
      button.type = "button";
      button.onclick = () => {
        resetKind(kind);
        el("kind-form").scrollIntoView({ behavior: "auto", block: "nearest" });
      };
      row.append(button);
    } else row.append(text("span", "Operator-managed", "state"));
    list.append(row);
  }
  resetKind();
}
function renderProviders(data) {
  const list = el("provider-list");
  list.replaceChildren();
  if (!data.providers.length)
    list.append(
      text(
        "p",
        "No sign-in providers configured. Ask your operator to connect a provider.",
        "empty",
      ),
    );
  for (const provider of data.providers) {
    const row = document.createElement("div");
    row.className = "provider-row";
    const copy = document.createElement("div");
    copy.append(
      text("strong", provider.displayName || provider.kind),
      text("p", provider.kind + " sign-in"),
    );
    const ready = provider.enabled && provider.hasOAuthSecret;
    const label = ready
      ? "Ready"
      : provider.enabled
        ? "Credentials required"
        : "Disabled";
    row.append(copy, text("span", label, ready ? "state" : "state pending"));
    list.append(row);
  }
}
async function refresh() {
  el("refresh").disabled = true;
  try {
    const overview = await call("registry.overview");
    renderOverview(overview);
    const [kindData, extensions, providers] = await Promise.all([
      call("registry.kinds.list"),
      call("registry.extensions.read"),
      call("registry.providers.list"),
    ]);
    renderKinds(kindData);
    fill(el("extensions-form"), {
      extensions_json: JSON.stringify(extensions.extensions, null, 2),
    });
    renderProviders(providers);
    el("content").hidden = false;
    status("Connected. Changes apply to this project’s registry.");
  } catch (error) {
    status(
      error.message || "Registry unavailable. Check your project connection.",
      true,
    );
  } finally {
    el("refresh").disabled = false;
  }
}
async function save(form, name, input, message, after) {
  const button = form.querySelector("[data-save]");
  button.disabled = true;
  status("Saving changes…");
  try {
    await call(name, input);
    if (after) await after();
    status(message);
  } catch (error) {
    status(
      error.message ||
        "Could not save. Check the input values and your project access.",
      true,
    );
  } finally {
    button.disabled = false;
  }
}
// The host iframe permits scripts but deliberately forbids native form submission.
function bindSave(id, action) {
  const form = el(id);
  const button = form.querySelector("[data-save]");
  const run = () => {
    if (!button.disabled && form.reportValidity()) action(form);
  };
  button.addEventListener("click", run);
  form.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.isComposing &&
      event.target.tagName === "INPUT"
    ) {
      event.preventDefault();
      run();
    }
  });
  form.addEventListener("submit", (event) => event.preventDefault());
}
bindSave("branding-form", (form) => {
  const input = Object.fromEntries(new FormData(form));
  input.allow_indexing = form.elements.allow_indexing.checked;
  save(form, "registry.branding.update", input, "Branding saved.", async () =>
    renderOverview(await call("registry.overview")),
  );
});
bindSave("settings-form", (form) => {
  const input = {
    docs_external_url: form.elements.docs_external_url.value.trim(),
    require_approval: form.elements.require_approval.checked,
    manifest_require_kind: form.elements.manifest_require_kind.checked,
  };
  save(form, "registry.settings.update", input, "Settings saved.", async () =>
    renderOverview(await call("registry.overview")),
  );
});
bindSave("kind-form", (form) => {
  const input = {
    key: form.elements.key.value,
    label: form.elements.label.value,
    description: form.elements.description.value,
    public_page_enabled: form.elements.public_page_enabled.checked,
  };
  if (editing)
    input.extensions_schema_json = form.elements.extensions_schema_json.value;
  save(
    form,
    editing ? "registry.kinds.update" : "registry.kinds.create",
    input,
    "Kind saved.",
    async () => {
      renderKinds(await call("registry.kinds.list"));
      renderOverview(await call("registry.overview"));
    },
  );
});
bindSave("extensions-form", (form) => {
  save(
    form,
    "registry.extensions.update",
    { extensions_json: form.elements.extensions_json.value },
    "Manifest fields saved.",
  );
});
el("new-kind").onclick = () => resetKind();
el("refresh").onclick = refresh;
window.addEventListener("message", (event) => {
  if (
    port ||
    event.source !== parent ||
    event.data?.type !== "webdock:init" ||
    !nonce ||
    event.data.nonce !== nonce ||
    event.ports.length !== 1
  )
    return;
  port = event.ports[0];
  port.onmessage = (event) => {
    const task = pending.get(event.data?.id);
    if (!task) return;
    clearTimeout(task.timeout);
    pending.delete(event.data.id);
    event.data.error
      ? task.reject(Error(String(event.data.error)))
      : task.resolve(event.data.result);
  };
  refresh();
});
setTimeout(() => {
  if (!port)
    status("Open Managed Registry from your Webdock project to connect.", true);
}, 10000);
