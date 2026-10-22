import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Optional local-only Chrome exercise of the actual React component against the actual
 * HTTP adapter. Artifacts/profile remain in test temp for review; no real account is used.
 */
export const openPackageConsentBrowser = async (url: string, artifactDirectory: string) => {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/browser-fixture$/.test(url))
    throw new Error("Disposable local browser URL required");
  const profile = await mkdtemp(join(tmpdir(), "bookly-consent-browser-"));
  const child = spawn(
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE localhost",
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  let socket: WebSocket | undefined;
  try {
    let port = "";
    for (let n = 0; n < 100; n++) {
      try {
        port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0] ?? "";
      } catch {}
      if (port) break;
      await delay(50);
    }
    if (!port) throw new Error("Chrome CDP not ready");
    const target = (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: "PUT",
    }).then((r) => r.json())) as { webSocketDebuggerUrl: string };
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket?.addEventListener("open", () => resolve(), { once: true });
      socket?.addEventListener("error", () => reject(new Error("CDP failed")), { once: true });
    });
    let sequence = 0;
    const browserErrors: unknown[] = [];
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        method?: string;
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (!message.id) {
        if (message.method === "Runtime.exceptionThrown") browserErrors.push(message);
        return;
      }
      const promise = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) promise?.reject(new Error(message.error.message));
      else promise?.resolve(message.result);
    });
    const command = (method: string, params: object = {}) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket?.send(JSON.stringify({ id, method, params }));
      });
    await command("Network.enable");
    await command("Network.setBlockedURLs", {
      urls: ["https://*", "http://*.com/*", "http://*.net/*", "http://*.org/*"],
    });
    await command("Page.enable");
    await command("Page.bringToFront");
    await command("Runtime.enable");
    await command("Page.navigate", { url });
    const evaluate = async (expression: string) => {
      const reply = (await command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })) as { result: { value?: unknown }; exceptionDetails?: unknown };
      if (reply.exceptionDetails)
        throw new Error(`Browser evaluation failed: ${JSON.stringify(reply.exceptionDetails)}`);
      return reply.result.value;
    };
    const waitFor = async (expression: string) => {
      for (let n = 0; n < 150; n++) {
        if (await evaluate(expression)) return;
        await delay(40);
      }
      throw new Error(
        `Browser wait failed: ${expression}; ${await evaluate("document.body.innerText")}; ${JSON.stringify(browserErrors).slice(-8000)}`,
      );
    };
    const screenshot = async (width: number, name: string) => {
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
      await writeFile(join(artifactDirectory, name), Buffer.from(shot.data, "base64"));
    };
    const press = async (key: "Space" | "Enter") => {
      const params = {
        key: key === "Space" ? " " : "Enter",
        code: key,
        windowsVirtualKeyCode: key === "Space" ? 32 : 13,
      };
      await command("Input.dispatchKeyEvent", {
        ...params,
        type: "keyDown",
        text: key === "Space" ? " " : "\r",
      });
      await command("Input.dispatchKeyEvent", { ...params, type: "keyUp" });
    };
    return {
      evaluate,
      waitFor,
      screenshot,
      press,
      close: () => {
        socket?.close();
        child.kill();
      },
    };
  } catch (error) {
    socket?.close();
    child.kill();
    throw error;
  }
};
