/**
 * Mermaid diagram rendering for the Model Lab transcript.
 *
 * `mermaid` is a heavy dependency (its parser alone is hundreds of kB), so it is
 * imported lazily: a conversation with no diagram never downloads it, and the
 * console's own bundle stays the size it was. The import is memoised at module
 * scope so the second diagram in a session is instant.
 *
 * Three properties matter here:
 *
 * - **Never throw into render.** Mermaid source is model-authored, so it is
 *   routinely malformed. A parse failure must degrade to showing the source,
 *   not blank the message or crash the transcript.
 * - **`securityLevel: "strict"`.** Mermaid renders into the DOM; strict mode
 *   sanitises labels and blocks `click` handlers and raw HTML, so a diagram
 *   cannot become an injection vector.
 * - **Stable ids.** Mermaid writes into a global registry keyed by the element
 *   id, and a duplicate id makes the second render fail. Each diagram gets a
 *   unique id derived from a counter.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

let mermaidPromise: Promise<typeof import("mermaid").default> | undefined;
let diagramCounter = 0;

function loadMermaid(): Promise<typeof import("mermaid").default> {
  mermaidPromise ??= import("mermaid").then((mod) => {
    const mermaid = mod.default;
    mermaid.initialize({
      startOnLoad: false,
      // Strict: labels are sanitised and click/HTML directives are refused, so a
      // model-authored diagram cannot inject markup into the page.
      securityLevel: "strict",
      theme: "dark",
      fontFamily: "var(--font-mono)",
    });
    return mermaid;
  });
  return mermaidPromise;
}

/** Renders one Mermaid diagram, or falls back to the source on failure. */
export function MermaidDiagram({ source }: { source: string }): ReactNode {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef<string>(`mlab-mermaid-${(diagramCounter += 1)}`);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        const { svg: rendered } = await mermaid.render(idRef.current, source);
        if (!cancelled) setSvg(rendered);
      } catch {
        // Malformed source is expected from a model: show it instead of an
        // empty box, so the operator can see what it tried to draw.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (failed) {
    return (
      <pre
        style={{
          background: "var(--code-surface)",
          border: "1px solid var(--inner-border)",
          borderRadius: "8px",
          padding: "10px 12px",
          overflowX: "auto",
          fontSize: "11.5px",
          margin: "0 0 8px",
        }}
      >
        <div style={{ color: "var(--text-tertiary)", marginBottom: "4px", fontSize: "10.5px" }}>
          diagram could not be rendered — source shown
        </div>
        {source}
      </pre>
    );
  }

  if (svg === null) {
    return (
      <div style={{ color: "var(--text-tertiary)", fontSize: "11px", margin: "0 0 8px" }}>
        rendering diagram…
      </div>
    );
  }

  return (
    <div
      // Mermaid output is a self-contained SVG it produced under
      // `securityLevel: "strict"`, which sanitises labels and drops script and
      // event-handler content. There is no other way to mount its result.
      dangerouslySetInnerHTML={{ __html: svg }}
      style={{
        background: "var(--code-surface)",
        border: "1px solid var(--inner-border)",
        borderRadius: "8px",
        padding: "12px",
        margin: "0 0 8px",
        overflowX: "auto",
        display: "flex",
        justifyContent: "center",
      }}
    />
  );
}
