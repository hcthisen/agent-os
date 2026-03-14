import React from "react";

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          style={{
            background: "#151823",
            borderRadius: 4,
            color: "#c4d4ff",
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            fontSize: "0.95em",
            padding: "0.12rem 0.35rem",
          }}
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("[")) {
      const label = token.slice(1, token.indexOf("]"));
      const url = match[5] || "";
      nodes.push(
        <a
          key={key}
          href={url}
          rel="noreferrer"
          style={{ color: "#93c5fd" }}
          target="_blank"
        >
          {label}
        </a>
      );
    }

    lastIndex = pattern.lastIndex;
    index += 1;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

export function renderMarkdown(content: string): React.ReactNode[] {
  const normalized = String(content || "").replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n{2,}/);

  return blocks.map((block, blockIndex) => {
    const trimmed = block.trim();
    if (!trimmed) {
      return null;
    }

    const codeFence = trimmed.match(/^```([^\n]*)\n([\s\S]+)\n```$/);
    if (codeFence) {
      return (
        <pre
          key={`code-${blockIndex}`}
          style={{
            background: "#0f1320",
            border: "1px solid #283042",
            borderRadius: 8,
            color: "#dbe7ff",
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            fontSize: 12,
            margin: "0.4rem 0",
            overflowX: "auto",
            padding: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          <code>{codeFence[2]}</code>
        </pre>
      );
    }

    const lines = trimmed.split("\n");
    const orderedList = lines.every((line) => /^\d+\.\s+/.test(line.trim()));
    if (orderedList) {
      return (
        <ol key={`ol-${blockIndex}`} style={{ margin: "0.4rem 0 0.4rem 1.25rem", padding: 0 }}>
          {lines.map((line, lineIndex) => (
            <li key={`oli-${blockIndex}-${lineIndex}`} style={{ marginBottom: 4 }}>
              {renderInline(line.replace(/^\d+\.\s+/, ""), `oli-${blockIndex}-${lineIndex}`)}
            </li>
          ))}
        </ol>
      );
    }

    const unorderedList = lines.every((line) => /^[-*]\s+/.test(line.trim()));
    if (unorderedList) {
      return (
        <ul key={`ul-${blockIndex}`} style={{ margin: "0.4rem 0 0.4rem 1.25rem", padding: 0 }}>
          {lines.map((line, lineIndex) => (
            <li key={`uli-${blockIndex}-${lineIndex}`} style={{ marginBottom: 4 }}>
              {renderInline(line.replace(/^[-*]\s+/, ""), `uli-${blockIndex}-${lineIndex}`)}
            </li>
          ))}
        </ul>
      );
    }

    return (
      <p key={`p-${blockIndex}`} style={{ lineHeight: 1.6, margin: "0.4rem 0", whiteSpace: "pre-wrap" }}>
        {lines.map((line, lineIndex) => (
          <React.Fragment key={`line-${blockIndex}-${lineIndex}`}>
            {lineIndex > 0 ? <br /> : null}
            {renderInline(line, `line-${blockIndex}-${lineIndex}`)}
          </React.Fragment>
        ))}
      </p>
    );
  }).filter(Boolean) as React.ReactNode[];
}

