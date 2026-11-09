import { z } from "zod";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json"
}

export const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for structured data");

export const CellIndexSchema = z
  .number()
  .int()
  .min(0)
  .describe("Cell index (0-based)");

export const CodeSchema = z
  .string()
  .min(1, "Code cannot be empty")
  .describe("Code to execute");

export const LanguageSchema = z
  .string()
  .default("python")
  .describe("Language for the cell");

// Tool-specific schemas
export const NotebookUriSchema = z
  .string()
  .optional()
  .describe("Optional notebook URI to target. If not provided, uses the active notebook. Use notebook_list_open to get URIs.");

export const ListCellsInputSchema = z.object({
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

export type ListCellsInput = z.infer<typeof ListCellsInputSchema>;
