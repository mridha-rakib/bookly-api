/** P4K browser driver: approved local Chrome over CDP, loopback only.
 *
 * Every request of the driven tab is intercepted. Loopback continues; the Stripe.js script
 * request is answered with a local stub; every other request fails. Browser-wide, non-loopback
 * DNS resolution is also disabled (--host-resolver-rules), so other tabs cannot reach providers.
 *
 * The stub's confirmCardPayment() never contacts a network service: it calls a CDP binding that
 * only the harness process (same process as the fake gateway) handles, moving one existing fake
 * PaymentIntent. Automated journeys preset the result with set3ds(); in a manual session the stub
 * shows an in-page "simulated 3DS challenge" dialog. Client source and bundles are unchanged,
 * and a real Stripe page could never load this stub.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { P4K_LABEL } from "./p4k-harness-state.js";

const BINDING = "__p4kSimulatedAuthentication";
const stripeStub = () => `(() => {
  const pending = new Map(); let sequence = 0;
  window.__p4kSettleAuthentication = (id, ok) => { const settle = pending.get(id); pending.delete(id); if (settle) settle(ok === true); };
  const record = (clientSecret, result) => new Promise((resolve) => {
    const id = String(++sequence); pending.set(id, resolve);
    window.${BINDING}(JSON.stringify({ id, clientSecret, result }));
  });
  const challenge = () => new Promise((resolve) => {
    const box = document.createElement("div");
    box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-label", "Simulated 3DS challenge");
    box.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:15px system-ui";
    const card = document.createElement("div");
    card.style.cssText = "background:#fff;color:#111;max-width:420px;margin:16px;padding:20px;border-radius:12px;border:4px solid #b45309";
    const title = document.createElement("h2"); title.textContent = "Simulated 3DS challenge"; title.style.cssText = "margin:0 0 8px;font-size:18px";
    const note = document.createElement("p"); note.textContent = ${JSON.stringify(`${P4K_LABEL}. No bank, card network or Stripe service is contacted.`)};
    card.append(title, note);
    for (const [label, result] of [["Complete simulated authentication", "succeeded"], ["Fail simulated authentication", "failed"], ["Cancel simulated authentication", "canceled"]]) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label;
      button.style.cssText = "display:block;width:100%;margin-top:8px;padding:10px;border-radius:8px;border:1px solid #999;cursor:pointer";
      button.onclick = () => { box.remove(); resolve(result); };
      card.append(button);
    }
    box.append(card); document.body.append(box);
  });
  window.Stripe = function P4kSimulatedStripe() {
    return {
      _registerWrapper() {},
      elements() { return { create() { return { mount() {}, on() {}, off() {}, update() {}, destroy() {}, unmount() {} }; }, getElement() { return null; } }; },
      async createToken() { throw Error("Synthetic browser uses preseeded saved cards only"); },
      async createPaymentMethod() { throw Error("Synthetic browser uses preseeded saved cards only"); },
      async confirmCardPayment(clientSecret) {
        const result = window.__p4k3ds || await challenge();
        if (!(await record(clientSecret, result))) return { error: { message: "P4K simulated authentication could not be recorded" } };
        if (result !== "succeeded") return { error: { message: "P4K simulated authentication " + result } };
        return { paymentIntent: { id: String(clientSecret).replace(/_secret$/, ""), status: "succeeded" } };
      },
    };
  };
  window.Stripe.version = "dahlia";
})();`;

export type P4kPage = {
  evaluate: <T = unknown>(expression: string) => Promise<T>;
  waitFor: (expression: string, timeoutMs?: number) => Promise<void>;
  goto: (url: string) => Promise<void>;
  reload: () => Promise<void>;
  /** BC-F06 deterministic Date only; timers and network remain real. */
  setClock: (iso: string) => Promise<void>;
  click: (text: string, root?: string) => Promise<void>;
  select: (
    label: string,
    pick: "first" | "last" | { value: string } | { text: string },
  ) => Promise<string>;
  fill: (selector: string, value: string) => Promise<void>;
  check: (labelText: string) => Promise<void>;
  travel: (address: {
    city: string;
    area: string;
    streetName: string;
    streetNumber: string;
  }) => Promise<void>;
  text: () => Promise<string>;
  screenshot: (name: string, width?: number) => Promise<void>;
  /** Preset the simulated 3DS result; "manual" shows the in-page challenge dialog instead. */
  set3ds: (result: "succeeded" | "failed" | "manual") => Promise<void>;
  clearStorage: () => Promise<void>;
  /** Lets the next request whose URL contains `fragment` reach the server, then drops its
   * response (connection reset): a real lost response after the server has processed it. */
  dropNextResponse: (fragment: string) => Promise<void>;
  /** Loopback response metadata plus synthetic Legacy package mutation bodies for recovery evidence. */
  network: () => Array<{
    url: string;
    method: string;
    status: number | null;
    requestBody?: string;
  }>;
  browserErrors: () => unknown[];
  close: () => Promise<void>;
};

/** In-page helpers. Exact visible text/aria-label selectors; no test ids were added to UI. */
const helpers = `window.__p4k = {
  visible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); },
  click(text, root) {
    const scope = root ? document.querySelector(root) : document;
    const matches = Array.from(scope.querySelectorAll("button, a")).filter((b) => this.visible(b) && b.textContent.trim().includes(text));
    const el = matches[matches.length - 1];
    if (!el) throw Error("No visible control: " + text);
    if (el.disabled) throw Error("Control disabled: " + text);
    el.click();
  },
  select(label, pick) {
    // Newest row wins: pickers repeat the same aria-label per appointment.
    const el = Array.from(document.querySelectorAll('select[aria-label="' + label + '"]')).filter((e) => this.visible(e)).pop();
    if (!el) throw Error("No select: " + label);
    const options = Array.from(el.options).filter((o) => o.value);
    const option = pick === "first" ? options[0] : pick === "last" ? options[options.length - 1]
      : pick.value ? options.find((o) => o.value === pick.value) : options.find((o) => o.textContent.includes(pick.text));
    if (!option) throw Error("No option for " + label);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, option.value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return option.value;
  },
  fill(selector, value) {
    const el = Array.from(document.querySelectorAll(selector)).pop();
    if (!el) throw Error("No input: " + selector);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  },
  travel(address) {
    const box = Array.from(document.querySelectorAll("fieldset")).filter((f) => f.querySelector("legend")?.textContent.includes("Travel address")).pop();
    if (!box) throw Error("No travel address fieldset");
    const set = (el, value, proto) => { Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, value); el.dispatchEvent(new Event(proto === HTMLSelectElement ? "change" : "input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
    set(box.querySelector("select"), address.city, HTMLSelectElement);
    const inputs = Array.from(box.querySelectorAll("input"));
    ["area", "streetName", "streetNumber"].forEach((field, index) => set(inputs[index], address[field], HTMLInputElement));
  },
  check(text) {
    const label = Array.from(document.querySelectorAll("label")).find((l) => this.visible(l) && l.textContent.includes(text));
    const input = label && label.querySelector("input[type=checkbox]");
    if (!input) throw Error("No checkbox: " + text);
    if (!input.checked) input.click();
  },
};`;

export type P4kBrowserOptions = {
  /** Directory for screenshots; screenshots are refused without it. */
  artifacts?: string;
  /** Visible window for a manual session (same interception and binding as automation). */
  headed?: boolean;
  /** Harness-side handler: moves one existing fake PaymentIntent. Throws for anything else. */
  authenticate: (clientSecret: string, result: string) => unknown;
};

export async function openP4kBrowser(input: P4kBrowserOptions): Promise<P4kPage> {
  const executable = process.env["BOOKLY_TEST_BROWSER"];
  if (!executable || !existsSync(executable))
    throw Error("Set BOOKLY_TEST_BROWSER to the approved test browser executable");
  const profile = await mkdtemp(join(tmpdir(), "bookly-p4k-browser-"));
  const child: ChildProcess = spawn(
    executable,
    [
      ...(input.headed ? [] : ["--headless=new"]),
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-proxy-server",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  let socket: WebSocket | undefined;
  try {
    let port = "";
    for (let n = 0; n < 200 && !port; n++) {
      try {
        port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0] ?? "";
      } catch {
        /* not ready */
      }
      if (!port) await delay(50);
    }
    if (!port) throw Error("Chrome CDP not ready");
    const target = (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: "PUT",
    }).then((r) => r.json())) as { webSocketDebuggerUrl: string };
    if (!target.webSocketDebuggerUrl.startsWith("ws://127.0.0.1:"))
      throw Error("Nonlocal CDP target");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    socket = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(Error("CDP failed")), { once: true });
    });
    let sequence = 0;
    const pending = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const errors: unknown[] = [];
    const responses: Array<{
      url: string;
      method: string;
      status: number | null;
      requestBody?: string;
    }> = [];
    const requestMethods = new Map<string, { method: string; url: string; postData?: string }>();
    const packageMutationRequests = new Map<string, number>();
    const command = (method: string, params: object = {}) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const stub = Buffer.from(stripeStub()).toString("base64");
    let dropFragment: string | undefined;
    const dispatch = (method: string, params: object) => {
      void command(method, params).catch((error: unknown) => {
        // Chrome may invalidate a paused request when navigation or tab shutdown wins the
        // race. Record other control failures, and always consume the CDP rejection.
        if (!String(error).includes("Invalid InterceptionId"))
          errors.push({ cdpCommand: method, error: String(error) });
      });
    };
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: {
          requestId: string;
          request: { url: string; method: string; postData?: string };
          responseStatusCode?: number;
          response?: { url: string; status: number };
          name?: string;
          payload?: string;
          executionContextId?: number;
        };
        result?: unknown;
        error?: { message: string };
      };
      if (message.id) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry?.reject(Error(message.error.message));
        else entry?.resolve(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params);
      if (message.method === "Network.requestWillBeSent" && message.params) {
        requestMethods.set(message.params.requestId, {
          method: message.params.request.method,
          url: message.params.request.url,
          ...(message.params.request.postData ? { postData: message.params.request.postData } : {}),
        });
        if (
          message.params.request.method === "POST" &&
          message.params.request.url.startsWith("http://127.0.0.1:") &&
          message.params.request.url.includes("/api/v1/businesses/") &&
          message.params.request.url.includes("/bookings/packages/") &&
          (message.params.request.url.endsWith("/sessions") ||
            message.params.request.url.endsWith("/purchase"))
        ) {
          packageMutationRequests.set(message.params.requestId, responses.length);
          responses.push({
            url: message.params.request.url,
            method: "POST",
            status: null,
            ...(message.params.request.postData
              ? { requestBody: message.params.request.postData }
              : {}),
          });
        }
      }
      if (message.method === "Network.responseReceived" && message.params?.response) {
        const { url, status } = message.params.response;
        if (url.startsWith("http://127.0.0.1:") && url.includes("/api/v1/")) {
          const packageRequestIndex = packageMutationRequests.get(message.params.requestId);
          if (packageRequestIndex !== undefined) responses[packageRequestIndex]!.status = status;
          else
            responses.push({
              url,
              status,
              method: requestMethods.get(message.params.requestId)?.method ?? "UNKNOWN",
            });
          if (responses.length > 2000) responses.shift();
        }
        requestMethods.delete(message.params.requestId);
      }
      if (message.method === "Runtime.bindingCalled" && message.params?.name === BINDING) {
        const { payload = "", executionContextId } = message.params;
        let id = "",
          ok = false;
        try {
          const call = JSON.parse(payload) as { id: string; clientSecret: string; result: string };
          id = String(call.id);
          input.authenticate(String(call.clientSecret), String(call.result));
          ok = true;
        } catch {
          ok = false;
        }
        void command("Runtime.evaluate", {
          contextId: executionContextId,
          expression: `window.__p4kSettleAuthentication?.(${JSON.stringify(id)}, ${ok})`,
        }).catch(() => undefined);
        return;
      }
      if (message.method === "Fetch.requestPaused" && message.params) {
        const { requestId, request } = message.params,
          url = new URL(request.url);
        if (message.params.responseStatusCode !== undefined) {
          // Response stage: only armed by dropNextResponse() for one loopback API URL.
          if (dropFragment && request.method === "POST" && request.url.includes(dropFragment)) {
            dropFragment = undefined;
            void command("Fetch.failRequest", { requestId, errorReason: "ConnectionReset" })
              .then(() => command("Fetch.enable", { patterns: [{ urlPattern: "*" }] }))
              .catch((error: unknown) => {
                if (!String(error).includes("Invalid InterceptionId"))
                  errors.push({ cdpCommand: "Fetch.failRequest", error: String(error) });
              });
          } else dispatch("Fetch.continueRequest", { requestId });
          return;
        }
        if (url.hostname === "127.0.0.1") dispatch("Fetch.continueRequest", { requestId });
        else if (url.hostname === "js.stripe.com")
          dispatch("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            body: stub,
            responseHeaders: [{ name: "Content-Type", value: "application/javascript" }],
          });
        else dispatch("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      }
    });
    await command("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await command("Network.enable");
    await command("Page.enable");
    await command("Runtime.enable");
    await command("Runtime.addBinding", { name: BINDING });
    await command("Page.addScriptToEvaluateOnNewDocument", { source: helpers });
    const evaluate = async <T>(expression: string) => {
      const reply = (await command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })) as { result: { value?: T }; exceptionDetails?: unknown };
      if (reply.exceptionDetails)
        throw Error(
          `Browser evaluation failed: ${JSON.stringify(reply.exceptionDetails).slice(0, 2000)}`,
        );
      return reply.result.value as T;
    };
    const waitFor = async (expression: string, timeoutMs = 60000) => {
      const end = performance.now() + timeoutMs;
      while (performance.now() < end) {
        try {
          if (await evaluate<boolean>(`Boolean(${expression})`)) return;
        } catch {
          /* navigating */
        }
        await delay(100);
      }
      throw Error(
        `Browser wait failed: ${expression}\n${(await evaluate<string>("document.body?.innerText ?? ''")).slice(0, 4000)}\n${JSON.stringify(errors).slice(-3000)}`,
      );
    };
    const ready = () => waitFor("document.readyState === 'complete' && window.__p4k", 180000);
    const page: P4kPage = {
      evaluate,
      waitFor,
      setClock: async (iso) => {
        if (!Number.isFinite(Date.parse(iso))) throw Error("Valid synthetic clock required");
        const source = `(() => { const OriginalDate = Date; const fixed = ${JSON.stringify(iso)};
          globalThis.Date = class extends OriginalDate {
            constructor(...args) { super(...(args.length ? args : [fixed])); }
            static now() { return new OriginalDate(fixed).getTime(); }
          }; })();`;
        await command("Page.addScriptToEvaluateOnNewDocument", { source });
        await evaluate(source);
      },
      goto: async (url) => {
        if (!url.startsWith("http://127.0.0.1:")) throw Error("Loopback URL required");
        await command("Page.navigate", { url });
        await delay(200);
        await ready();
      },
      reload: async () => {
        await command("Page.reload");
        await delay(200);
        await ready();
      },
      click: async (text, root) => {
        await evaluate(
          `window.__p4k.click(${JSON.stringify(text)}, ${JSON.stringify(root ?? null)})`,
        );
      },
      select: (label, pick) =>
        evaluate<string>(`window.__p4k.select(${JSON.stringify(label)}, ${JSON.stringify(pick)})`),
      fill: async (selector, value) => {
        await evaluate(`window.__p4k.fill(${JSON.stringify(selector)}, ${JSON.stringify(value)})`);
      },
      check: async (text) => {
        await evaluate(`window.__p4k.check(${JSON.stringify(text)})`);
      },
      travel: async (address) => {
        await evaluate(`window.__p4k.travel(${JSON.stringify(address)})`);
      },
      text: () => evaluate<string>("document.body.innerText"),
      screenshot: async (name, width = 1280) => {
        const directory = input.artifacts;
        if (!directory) throw Error("Screenshots require an artifacts directory");
        await command("Emulation.setDeviceMetricsOverride", {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: width < 600,
        });
        const shot = (await command("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
        })) as { data: string };
        await writeFile(join(directory, name), Buffer.from(shot.data, "base64"));
      },
      set3ds: async (result) => {
        await evaluate(
          result === "manual"
            ? "delete window.__p4k3ds"
            : `window.__p4k3ds = ${JSON.stringify(result)}`,
        );
      },
      dropNextResponse: async (fragment) => {
        dropFragment = fragment;
        await command("Fetch.enable", {
          patterns: [
            { urlPattern: "*" },
            { urlPattern: `*${fragment}*`, requestStage: "Response" },
          ],
        });
      },
      clearStorage: async () => {
        await command("Network.clearBrowserCookies");
        await evaluate(
          "(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} })()",
        );
      },
      network: () => [...responses],
      browserErrors: () => [...errors],
      close: async () => {
        await command("Fetch.disable").catch(() => undefined);
        ws.close();
        child.kill();
      },
    };
    return page;
  } catch (error) {
    socket?.close();
    child.kill();
    throw error;
  }
}
