/**
 * @fileoverview Markdown builder utility for creating well-structured, semantic markdown content
 * @module utils/formatting/markdownBuilder
 */

/**
 * Utility class for building well-formatted markdown content with consistent structure.
 *
 * This builder provides a fluent API for creating markdown documents with proper
 * spacing, hierarchy, and semantic structure. It helps eliminate string concatenation
 * and ensures consistent formatting across all tool response formatters.
 *
 * @example
 * ```typescript
 * const markdown = new MarkdownBuilder()
 *   .h2('Query Results')
 *   .keyValue('Rows', 2)
 *   .list(['EMPLOYEE', 'DEPARTMENT'])
 *   .build();
 * ```
 */
export class MarkdownBuilder {
  private sections: string[] = [];

  /**
   * Add a level 2 heading.
   * @param text - The heading text
   * @param emoji - Optional emoji to prepend
   * @returns this builder for chaining
   */
  h2(text: string, emoji?: string): this {
    const prefix = emoji ? `${emoji} ` : "";
    this.sections.push(`## ${prefix}${text}\n\n`);
    return this;
  }

  /**
   * Add a level 3 heading.
   * @param text - The heading text
   * @param emoji - Optional emoji to prepend
   * @returns this builder for chaining
   */
  h3(text: string, emoji?: string): this {
    const prefix = emoji ? `${emoji} ` : "";
    this.sections.push(`### ${prefix}${text}\n\n`);
    return this;
  }

  /**
   * Add a bold key-value pair on a single line.
   * @param key - The key (will be bolded)
   * @param value - The value
   * @returns this builder for chaining
   */
  keyValue(key: string, value: string | number | boolean | null): this {
    const displayValue = value === null ? "null" : String(value);
    this.sections.push(`**${key}:** ${displayValue}\n`);
    return this;
  }

  /**
   * Add a bulleted or numbered list.
   * @param items - Array of items to list
   * @param ordered - If true, creates a numbered list
   * @returns this builder for chaining
   */
  list(items: string[], ordered = false): this {
    if (items.length === 0) return this;

    const marker = ordered ? (i: number) => `${i + 1}.` : () => "-";
    this.sections.push(
      items.map((item, i) => `${marker(i)} ${item}`).join("\n") + "\n\n",
    );
    return this;
  }

  /**
   * Add a code block with optional language syntax highlighting.
   * @param content - The code content
   * @param language - Optional language identifier (e.g., 'typescript', 'diff', 'json')
   * @returns this builder for chaining
   */
  codeBlock(content: string, language = ""): this {
    this.sections.push(`\`\`\`${language}\n${content}\n\`\`\`\n\n`);
    return this;
  }

  /**
   * Add a paragraph of text.
   * @param text - The paragraph content
   * @returns this builder for chaining
   */
  paragraph(text: string): this {
    this.sections.push(`${text}\n\n`);
    return this;
  }

  /**
   * Add a status/alert box (GitHub/GitLab style).
   * Renders as a highlighted blockquote with an icon.
   *
   * Supported types:
   * - 'note': 📝 Neutral information
   * - 'tip': 💡 Helpful suggestions
   * - 'important': ❗ Critical information
   * - 'warning': ⚠️ Warning/caution
   * - 'caution': 🚨 Danger/destructive action
   *
   * @param type - Alert type
   * @param content - Alert content (can be multi-line)
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * md.alert('warning', 'This operation cannot be undone!');
   * // Renders: > [!WARNING]
   * //          > This operation cannot be undone!
   * ```
   */
  alert(
    type: "note" | "tip" | "important" | "warning" | "caution",
    content: string,
  ): this {
    const typeUpper = type.toUpperCase();
    const lines = content.split("\n");
    this.sections.push(`> [!${typeUpper}]\n`);
    lines.forEach((line) => {
      this.sections.push(`> ${line}\n`);
    });
    this.sections.push("\n");
    return this;
  }

  /**
   * Add raw markdown content directly.
   * Use this for custom formatting not covered by other methods.
   *
   * @param markdown - Raw markdown string
   * @returns this builder for chaining
   */
  raw(markdown: string): this {
    this.sections.push(markdown);
    return this;
  }

  /**
   * Add a blank line for spacing.
   * @returns this builder for chaining
   */
  blankLine(): this {
    this.sections.push("\n");
    return this;
  }

  /**
   * Build the final markdown string.
   * Trims trailing whitespace and ensures the document ends cleanly.
   *
   * @returns The complete markdown document as a string
   */
  build(): string {
    return this.sections.join("").trim();
  }
}

/**
 * Helper function to create a MarkdownBuilder instance.
 * Provides a shorter alternative to `new MarkdownBuilder()`.
 *
 * @returns A new MarkdownBuilder instance
 */
export function markdown(): MarkdownBuilder {
  return new MarkdownBuilder();
}
