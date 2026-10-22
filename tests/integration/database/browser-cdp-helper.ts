import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Optional local-browser verification, using Node's native WebSocket (no added dependency).
const executable =
  process.env["BOOKLY_TEST_BROWSER"] ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
export const hasLocalBrowser = existsSync(executable);

export const startTestBrowser = async () => {
  const directory = await mkdtemp(join(tmpdir(), "bookly-cookie-race-"));
  const processHandle = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${directory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  const connections: WebSocket[] = [];
  const close = async () => {
    for (const socket of connections) socket.close();
    const exited = new Promise<void>((resolve) => processHandle.once("exit", () => resolve()));
    processHandle.kill();
    await Promise.race([exited, delay(3000)]);
    // Verify the absolute target before recursively removing this fresh test profile.
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("bookly-cookie-race-")
    ) {
      throw new Error("Refusing to remove a browser profile outside the test temporary directory");
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  try {
    let port = "";
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        port = (await readFile(join(directory, "DevToolsActivePort"), "utf8")).split("\n")[0] ?? "";
        if (port) break;
      } catch {
        /* Chrome has not published its debugging endpoint yet. */
      }
      await delay(50);
    }
    if (!port) throw new Error("Browser debugging endpoint did not start");
    const page = async (url: string) => {
      const target = (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
        method: "PUT",
      }).then((res) => res.json())) as { webSocketDebuggerUrl: string };
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      connections.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("CDP connection failed")), {
          once: true,
        });
      });
      let sequence = 0;
      const pending = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (reason: Error) => void }
      >();
      socket.addEventListener("message", (message) => {
        const data = JSON.parse(String(message.data)) as {
          id?: number;
          result?: unknown;
          error?: { message: string };
        };
        if (data.id === undefined) return;
        const waiter = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) waiter?.reject(new Error(data.error.message));
        else waiter?.resolve(data.result);
      });
      const command = (method: string, params: Record<string, unknown> = {}) =>
        new Promise<unknown>((resolve, reject) => {
          const id = ++sequence;
          pending.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params }));
        });
      const evaluate = async (expression: string): Promise<unknown> => {
        const value = (await command("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        })) as { result: { value?: unknown }; exceptionDetails?: unknown };
        if (value.exceptionDetails) throw new Error("Browser evaluation failed");
        return value.result.value;
      };
      await command("Page.enable");
      await command("Page.navigate", { url });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          await evaluate(
            "document.readyState === 'complete' && location.pathname === '/browser-fixture'",
          )
        )
          break;
        await delay(25);
      }
      return { evaluate };
    };
    return { page, close };
  } catch (error) {
    await close();
    throw error;
  }
};
