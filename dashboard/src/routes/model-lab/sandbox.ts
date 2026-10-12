/**
 * The `run_javascript` sandbox.
 *
 * Model-authored JavaScript must never run in the page's own realm: the console
 * holds session cookies, the CSRF token, and the operator's authenticated
 * fetch, so `eval` here would hand a model full control of the dashboard.
 *
 * This runs the code in a dedicated Worker instead. A Worker is a separate
 * global with no DOM, no `window`, and no access to the page's variables, so the
 * blast radius is the worker's own scope. Three further limits are applied:
 *
 * - **Termination.** A Worker is killed after `TIMEOUT_MS`. Without this an
 *   `while (true) {}` from the model would pin a core forever and the tab would
 *   stop responding, with no way back short of a reload.
 * - **No network.** `fetch`, `XMLHttpRequest`, and `importScripts` are replaced
 *   with throwers inside the worker, so model code cannot exfiltrate the
 *   conversation or reach the gateway with the page's cookies.
 * - **Bounded output.** The result is truncated before it is returned, because
 *   it is fed straight back into the model's context.
 *
 * The worker source is a Blob URL created at call time, so nothing has to be
 * shipped as a separate asset and the sandbox is exactly the code below.
 */

const TIMEOUT_MS = 5_000;
const MAX_RESULT_CHARS = 20_000;

/** Body of the worker. Kept as a string so it is self-contained. */
const WORKER_SOURCE = `
self.onmessage = (event) => {
  const { code, input } = event.data || {};
  // Strip the escape hatches before the model's code runs. These are the only
  // ways out of the worker's scope, so removing them is what makes it a sandbox
  // rather than just a second thread.
  const blocked = () => { throw new Error("network access is disabled in the sandbox"); };
  self.fetch = blocked;
  self.XMLHttpRequest = blocked;
  self.importScripts = blocked;
  self.WebSocket = blocked;
  self.EventSource = blocked;

  try {
    // The final expression is the result, so wrap the source in a function that
    // returns it. "input" is injected as a parameter.
    const fn = new Function("input", '"use strict"; return (\\n' + code + '\\n);');
    const value = fn(input);
    let out;
    if (value === undefined) out = "undefined";
    else if (typeof value === "string") out = value;
    else {
      try { out = JSON.stringify(value, null, 2); }
      catch { out = String(value); }
    }
    self.postMessage({ ok: true, result: out });
  } catch (error) {
    self.postMessage({ ok: false, error: error && error.message ? error.message : String(error) });
  }
};
`;

export interface SandboxResult {
  readonly ok: boolean;
  readonly result?: string;
  readonly error?: string;
}

/** Runs `code` in a sandboxed worker. Never throws: a failure is a result. */
export function runInSandbox(code: string, input?: string): Promise<SandboxResult> {
  return new Promise((resolve) => {
    let worker: Worker;
    let blobUrl: string;
    try {
      blobUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      worker = new Worker(blobUrl);
    } catch (error) {
      resolve({ ok: false, error: `sandbox unavailable: ${error instanceof Error ? error.message : "worker blocked"}` });
      return;
    }

    let settled = false;
    const finish = (result: SandboxResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
      resolve(result);
    };

    // A model can emit an infinite loop; without this the tab would hang with no
    // way to recover, so the timeout is the load-bearing safety property.
    const timer = setTimeout(() => {
      finish({ ok: false, error: `execution exceeded ${TIMEOUT_MS / 1000}s and was terminated` });
    }, TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as { ok?: boolean; result?: string; error?: string } | null;
      if (!data || typeof data.ok !== "boolean") {
        finish({ ok: false, error: "sandbox returned an unexpected message" });
        return;
      }
      if (!data.ok) {
        finish({ ok: false, error: data.error ?? "unknown error" });
        return;
      }
      const text = data.result ?? "";
      finish({
        ok: true,
        result:
          text.length > MAX_RESULT_CHARS
            ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated at ${MAX_RESULT_CHARS} chars)`
            : text,
      });
    };

    worker.onerror = (event: ErrorEvent) => {
      finish({ ok: false, error: event.message || "sandbox error" });
    };

    try {
      worker.postMessage({ code, input });
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : "could not start sandbox" });
    }
  });
}
