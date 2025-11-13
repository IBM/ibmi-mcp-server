/**
 * @fileoverview Barrel file for formatting utility modules.
 * This file re-exports utilities for building structured output formats including
 * markdown, tables, diffs, and tree structures.
 * @module utils/formatting
 */

export { MarkdownBuilder, markdown } from "./markdownBuilder.js";
export {
  tableFormatter,
  TableFormatter,
  type TableFormatterOptions,
  type TableStyle,
  type Alignment,
  type TableFormattingResult,
} from "./tableFormatter.js";
export {
  getColumnAlignment,
  formatColumnHeader,
  buildColumnAlignmentMap,
} from "./sqlFormattingUtils.js";
