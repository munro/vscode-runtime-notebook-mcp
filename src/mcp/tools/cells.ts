import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ListCellsInputSchema, ResponseFormat, ResponseFormatSchema, CellIndexSchema, NotebookUriSchema } from "../../schemas/index.js";
import { parseOutputs, formatOutputsAsMarkdown } from "../../utils/output.js";
import { insertCells, deleteCells, generateCellId, editCellContent, moveCell, checkCanModifyNotebook, checkCanReadNotebook, clearCellOutputs } from "../../utils/notebook.js";
import { runCell, describeRanIn, describeStatus, waitForRunningCell, RunResult, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } from "../../utils/run.js";

// Track pending executions to prevent duplicate execution calls
// Key: "notebookUri:cellIndex" or "notebookUri:cellId"
const pendingExecutions = new Map<string, Promise<RunResult>>();

/**
 * Get execution key for tracking pending executions
 */
function getExecutionKey(notebookUri: string, cellIdentifier: string | number): string {
  return `${notebookUri}:${cellIdentifier}`;
}

function formatRun(index: number, run: RunResult, format: ResponseFormat, note?: string) {
  const result = { cellIndex: index, ...run, ...(note ? { note } : {}) };
  if (format === ResponseFormat.JSON) {
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
  const order = run.executionOrder !== null ? ` (execution #${run.executionOrder})` : "";
  const lines = [
    `# Cell ${index} Execution Result`,
    "",
    `**Status**: ${describeStatus(run)}${order}, ran ${describeRanIn(run.ranIn)}`,
    ...(note ? [`**Note**: ${note}`] : []),
    "",
    "## Output",
    formatOutputsAsMarkdown(run.outputs)
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}


const GetCellContentInputSchema = z.object({
  index: CellIndexSchema,
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

const GetCellOutputInputSchema = z.object({
  index: CellIndexSchema,
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

const TimeoutSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_TIMEOUT_SECONDS)
  .default(DEFAULT_TIMEOUT_SECONDS)
  .describe(`Seconds to wait for the run (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}). When it runs out the cell keeps running and the result says "running".`);

const InsertCellInputSchema = z.object({
  content: z.string().describe("Cell content (code or markdown)"),
  type: z.enum(["code", "markdown"]).default("code").describe("Cell type"),
  index: z.number().int().min(0).optional().describe("Position to insert (default: append at end)"),
  language: z.string().default("python").describe("Language for code cells"),
  execute: z.boolean().default(false).describe("Execute the cell after insertion (code cells only)"),
  timeout_seconds: TimeoutSchema,
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

const EditCellInputSchema = z.object({
  index: CellIndexSchema,
  content: z.string().describe("New content for the cell"),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

const DeleteCellInputSchema = z.object({
  index: CellIndexSchema,
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

const GetOutlineInputSchema = z.object({
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

const SearchInputSchema = z.object({
  query: z.string().min(1).describe("Search term"),
  case_sensitive: z.boolean().default(false).describe("Case-sensitive search"),
  context_lines: z.number().int().min(0).max(3).default(1).describe("Lines of context around matches"),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

const ClearOutputsInputSchema = z.object({
  index: CellIndexSchema,
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

const MoveCellInputSchema = z.object({
  from_index: CellIndexSchema.describe("Current cell index"),
  to_index: CellIndexSchema.describe("Target cell index"),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

const BulkAddCellsInputSchema = z.object({
  cells: z.array(z.object({
    content: z.string(),
    type: z.enum(["code", "markdown"]).default("code"),
    language: z.string().default("python")
  })).min(1).describe("Array of cells to add"),
  index: z.number().int().min(0).optional().describe("Position to insert (default: end)"),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

const RunCellInputSchema = z.object({
  index: CellIndexSchema,
  timeout_seconds: TimeoutSchema,
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

const RunCellsInputSchema = z.object({
  start: CellIndexSchema.default(0).describe("First cell to run (default 0)"),
  end: z.number().int().min(0).optional().describe("Run up to but not including this cell (default: through the last cell)"),
  stop_on_error: z.boolean().default(true).describe("Stop at the first cell that fails (default true)"),
  timeout_seconds: TimeoutSchema.describe("Seconds to wait for each cell; a cell still running when it runs out stops the batch"),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
}).strict();

const PER_CELL_OUTPUT_CHARS = 2000;

const ListOpenInputSchema = z.object({
  response_format: ResponseFormatSchema
}).strict();

const SaveNotebookInputSchema = z.object({
  notebook_uri: NotebookUriSchema
}).strict();

const ShowNotebookInputSchema = z.object({
  notebook_uri: z.string().describe("URI of the notebook to show (from notebook_list_open)"),
  index: CellIndexSchema.optional().describe("Cell to scroll to"),
  focus: z.boolean().default(false).describe("Also move keyboard focus into the notebook (default: keep it where the user is)")
}).strict();

export function registerCellTools(server: McpServer) {

  // notebook_run_cells
  server.tool(
    "notebook_run_cells",
    `Run a range of cells in order (default: the whole notebook), like "Run All" or "Run Above".

Markdown cells are skipped. Stops at the first failure unless stop_on_error is false, and always stops when a cell is still running after timeout_seconds (the rest would run against an unfinished kernel). Each cell's output is trimmed to ${PER_CELL_OUTPUT_CHARS} characters; use notebook_get_cell_output for the full output.`,
    RunCellsInputSchema.shape,
    async (params) => {
      const parsed = RunCellsInputSchema.parse(params);
      const accessCheck = await checkCanModifyNotebook(parsed.notebook_uri);
      if (!accessCheck.allowed) {
        return { content: [{ type: "text" as const, text: `Error: ${accessCheck.error}` }], isError: true };
      }
      const notebook = accessCheck.notebook!;
      const end = Math.min(parsed.end ?? notebook.cellCount, notebook.cellCount);
      if (parsed.start >= end) {
        return { content: [{ type: "text" as const, text: `Error: Empty range ${parsed.start}..${end} (notebook has ${notebook.cellCount} cells).` }], isError: true };
      }

      const results: Array<{ index: number; run?: RunResult; error?: string }> = [];
      let stopped: string | undefined;
      for (let index = parsed.start; index < end; index++) {
        const cell = notebook.cellAt(index);
        if (cell.kind !== vscode.NotebookCellKind.Code) continue;
        try {
          const run = await (waitForRunningCell(notebook, cell, parsed.timeout_seconds * 1000) ?? runCell(notebook, cell, parsed.timeout_seconds));
          results.push({ index, run });
          if (run.status === "running") {
            stopped = `cell ${index} is still running`;
            break;
          }
          if (!run.success && parsed.stop_on_error) {
            stopped = `cell ${index} failed`;
            break;
          }
        } catch (error) {
          results.push({ index, error: error instanceof Error ? error.message : String(error) });
          stopped = `cell ${index} could not run`;
          break;
        }
      }

      const ok = results.filter((r) => r.run?.status === "done" && r.run.success).length;
      const summary = `${ok}/${results.length} code cells succeeded${stopped ? `; stopped: ${stopped}` : ""}`;
      if (parsed.response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ summary, stopped: stopped ?? null, results }, null, 2) }] };
      }
      const lines = [`# Ran cells ${parsed.start}..${end - 1}`, "", `**${summary}**`, ""];
      for (const r of results) {
        if (r.error) {
          lines.push(`## Cell ${r.index}: could not run`, r.error, "");
          continue;
        }
        const run = r.run!;
        const order = run.executionOrder !== null ? ` (#${run.executionOrder})` : "";
        let out = formatOutputsAsMarkdown(run.outputs);
        if (out.length > PER_CELL_OUTPUT_CHARS) out = out.slice(0, PER_CELL_OUTPUT_CHARS) + "\n[... trimmed; notebook_get_cell_output has the rest]";
        lines.push(`## Cell ${r.index}: ${describeStatus(run)}${order}, ran ${describeRanIn(run.ranIn)}`);
        if (out) lines.push(out);
        lines.push("");
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // notebook_save
  server.tool(
    "notebook_save",
    `Save a notebook to disk (VS Code's own save of the open editor, so it never conflicts with what the user sees). Use it before anything reads the .ipynb file, e.g. git or a script.`,
    SaveNotebookInputSchema.shape,
    async (params) => {
      const parsed = SaveNotebookInputSchema.parse(params);
      const target = await checkCanReadNotebook(parsed.notebook_uri);
      if (!target.allowed) {
        return { content: [{ type: "text" as const, text: `Error: ${target.error}` }], isError: true };
      }
      const notebook = target.notebook!;
      const name = notebook.uri.fsPath.split("/").pop();
      if (!notebook.isDirty) {
        return { content: [{ type: "text" as const, text: `${name} has no unsaved changes.` }] };
      }
      const saved = await notebook.save();
      return saved
        ? { content: [{ type: "text" as const, text: `Saved ${name}.` }] }
        : { content: [{ type: "text" as const, text: `Error: VS Code did not save ${name}.` }], isError: true };
    }
  );

  // notebook_show
  server.tool(
    "notebook_show",
    `Bring an open notebook into view, optionally scrolled to a cell. Keyboard focus stays where the user is unless focus is true.

Use it before running cells you want the user to watch: runs in a visible notebook show their output under the cell, while runs in a notebook that is not on screen go to its kernel and only return the output to you. Showing a notebook also starts its kernel when you then run a cell.`,
    ShowNotebookInputSchema.shape,
    async (params) => {
      const parsed = ShowNotebookInputSchema.parse(params);
      const target = await checkCanReadNotebook(parsed.notebook_uri);
      if (!target.allowed) {
        return { content: [{ type: "text" as const, text: `Error: ${target.error}` }], isError: true };
      }
      const notebook = target.notebook!;
      if (parsed.index !== undefined && parsed.index >= notebook.cellCount) {
        return { content: [{ type: "text" as const, text: `Error: Cell index ${parsed.index} out of range (0-${notebook.cellCount - 1}).` }], isError: true };
      }
      const range = parsed.index !== undefined ? new vscode.NotebookRange(parsed.index, parsed.index + 1) : undefined;
      const editor = await vscode.window.showNotebookDocument(notebook, {
        preserveFocus: !parsed.focus,
        preview: false,
        ...(range ? { selections: [range] } : {})
      });
      if (range) editor.revealRange(range, vscode.NotebookEditorRevealType.InCenter);
      const where = parsed.index !== undefined ? ` at cell ${parsed.index}` : "";
      return { content: [{ type: "text" as const, text: `Showing ${notebook.uri.fsPath.split("/").pop()}${where}.` }] };
    }
  );
  // notebook_list_open
  server.tool(
    "notebook_list_open",
    "List all open notebooks with their URIs, filenames, cell counts, which one is active, which are on screen (runs there show output under the cell), and which have unsaved changes.",
    ListOpenInputSchema.shape,
    async (params) => {
      const parsed = ListOpenInputSchema.parse(params);
      const notebooks = vscode.workspace.notebookDocuments;
      const activeUri = vscode.window.activeNotebookEditor?.notebook.uri.toString();
      const visible = new Set(vscode.window.visibleNotebookEditors.map((e) => e.notebook.uri.toString()));

      const result = notebooks.map((nb) => ({
        uri: nb.uri.toString(),
        fileName: nb.uri.path.split("/").pop() || "unknown",
        cellCount: nb.cellCount,
        isActive: nb.uri.toString() === activeUri,
        isVisible: visible.has(nb.uri.toString()),
        isDirty: nb.isDirty
      }));

      if (parsed.response_format === ResponseFormat.JSON) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ notebooks: result }, null, 2) }]
        };
      }

      if (result.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No notebooks open. Open a .ipynb file first." }]
        };
      }

      const lines = [`# Open Notebooks (${result.length})`, ""];
      for (const nb of result) {
        const flags = [nb.isActive ? "active" : nb.isVisible ? "on screen" : "not on screen", ...(nb.isDirty ? ["unsaved changes"] : [])];
        lines.push(`- **${nb.fileName}** (${nb.cellCount} cells) — ${flags.join(", ")}`);
        lines.push(`  \`${nb.uri}\``);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }]
      };
    }
  );

  // notebook_list_cells
  server.tool(
    "notebook_list_cells",
    "List all cells in the active notebook with metadata including type, language, content preview, and execution state.",
    ListCellsInputSchema.shape,
    async (params) => {
      const target = await checkCanReadNotebook(ListCellsInputSchema.parse(params).notebook_uri);
      if (!target.allowed) {
        return { content: [{ type: "text" as const, text: `Error: ${target.error}` }], isError: true };
      }
      const notebook = target.notebook!;

      const cells = notebook.getCells().map((cell, index) => ({
        index,
        kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
        language: cell.document.languageId,
        lineCount: cell.document.lineCount,
        preview: cell.document.getText().substring(0, 100).replace(/\n/g, "↵"),
        hasOutput: cell.outputs.length > 0,
        executionOrder: cell.executionSummary?.executionOrder ?? null
      }));

      const output = { total: cells.length, cells };
      const { response_format } = ListCellsInputSchema.parse(params);

      if (response_format === ResponseFormat.JSON) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }]
        };
      }

      const lines = [`# Notebook Cells (${cells.length} total)`, ""];
      for (const cell of cells) {
        const exec = cell.executionOrder ? ` [${cell.executionOrder}]` : "";
        const out = cell.hasOutput ? " 📊" : "";
        lines.push(`## Cell ${cell.index}${exec}${out} (${cell.kind}/${cell.language})`);
        lines.push("```");
        lines.push(cell.preview + (cell.lineCount > 3 ? "..." : ""));
        lines.push("```");
        lines.push("");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }]
      };
    }
  );

  // notebook_get_cell_content
  server.tool(
    "notebook_get_cell_content",
    `Get the full source code of a specific cell.

Args:
  - index (number): Cell index (0-based)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
    GetCellContentInputSchema.shape,
    async (params) => {
      const target = await checkCanReadNotebook(GetCellContentInputSchema.parse(params).notebook_uri);
      if (!target.allowed) {
        return { content: [{ type: "text" as const, text: `Error: ${target.error}` }], isError: true };
      }
      const notebook = target.notebook!;

      const parsed = GetCellContentInputSchema.parse(params);

      if (parsed.index >= notebook.cellCount) {
        return {
          content: [{ type: "text" as const, text: `Error: Cell index ${parsed.index} out of range (0-${notebook.cellCount - 1}).` }],
          isError: true
        };
      }

      const cell = notebook.cellAt(parsed.index);
      const output = {
        index: parsed.index,
        kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
        language: cell.document.languageId,
        content: cell.document.getText()
      };

      if (parsed.response_format === ResponseFormat.JSON) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }]
        };
      }

      const lines = [
        `# Cell ${parsed.index} (${output.kind}/${output.language})`,
        "",
        "```" + output.language,
        output.content,
        "```"
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }]
      };
    }
  );

  // notebook_get_cell_output
  server.tool(
    "notebook_get_cell_output",
    `Get the outputs of a specific cell (text, errors, images).

Args:
  - index (number): Cell index (0-based)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
    GetCellOutputInputSchema.shape,
    async (params) => {
      const target = await checkCanReadNotebook(GetCellOutputInputSchema.parse(params).notebook_uri);
      if (!target.allowed) {
        return { content: [{ type: "text" as const, text: `Error: ${target.error}` }], isError: true };
      }
      const notebook = target.notebook!;

      const parsed = GetCellOutputInputSchema.parse(params);

      if (parsed.index >= notebook.cellCount) {
        return {
          content: [{ type: "text" as const, text: `Error: Cell index ${parsed.index} out of range (0-${notebook.cellCount - 1}).` }],
          isError: true
        };
      }

      const cell = notebook.cellAt(parsed.index);
      const outputs = parseOutputs(cell.outputs);

      const output = {
        index: parsed.index,
        hasOutput: outputs.length > 0,
        executionOrder: cell.executionSummary?.executionOrder ?? null,
        outputs
      };

      if (parsed.response_format === ResponseFormat.JSON) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }]
        };
      }

      if (outputs.length === 0) {
        return {
          content: [{ type: "text" as const, text: `# Cell ${parsed.index} Output\n\nNo output available.` }]
        };
      }

      const lines = [
        `# Cell ${parsed.index} Output`,
        output.executionOrder ? `Execution #${output.executionOrder}` : "",
        "",
        formatOutputsAsMarkdown(outputs)
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }]
      };
    }
  );

  // notebook_insert_cell
  server.tool(
    "notebook_insert_cell",
    `Insert a new cell (code or markdown) into the notebook.

Args:
  - content (string): Cell content
  - type ('code' | 'markdown'): Cell type (default: 'code')
  - index (number, optional): Position to insert (default: append at end)
  - language (string): Language for code cells (default: 'python')
  - execute (boolean): Execute after insertion, code cells only (default: false)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
    InsertCellInputSchema.shape,
    async (params) => {
      const parsed = InsertCellInputSchema.parse(params);
      const accessCheck = await checkCanModifyNotebook(parsed.notebook_uri);
      if (!accessCheck.allowed) {
        return {
          content: [{ type: "text" as const, text: `Error: ${accessCheck.error}` }],
          isError: true
        };
      }

      const notebook = accessCheck.notebook!;

      // Create cell with tracking ID
      const cellId = generateCellId();
      const cellKind = parsed.type === "code" ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup;
      const cellData = new vscode.NotebookCellData(
        cellKind,
        parsed.content,
        parsed.type === "code" ? parsed.language : "markdown"
      );
      cellData.metadata = { id: cellId };

      // Insert at specified index or at the end
      const insertIndex = parsed.index !== undefined ? Math.min(parsed.index, notebook.cellCount) : notebook.cellCount;
      await insertCells(notebook.uri, insertIndex, [cellData]);

      // Find the cell by metadata ID
      const cell = notebook.getCells().find((c) => c.metadata.id === cellId);
      if (!cell) {
        return {
          content: [{ type: "text" as const, text: "Error: Failed to create cell." }],
          isError: true
        };
      }

      const cellIndex = notebook.getCells().indexOf(cell);

      // Reveal the cell if editor is available
      if (accessCheck.editor) {
        accessCheck.editor.revealRange(
          new vscode.NotebookRange(cellIndex, cellIndex + 1),
          vscode.NotebookEditorRevealType.InCenter
        );
      }

      let executionResult = null;

      // Execute if requested and cell is code
      if (parsed.execute && parsed.type === "code") {
        const executionKey = getExecutionKey(notebook.uri.toString(), cellId);

        const pending = pendingExecutions.get(executionKey);
        const executionPromise = pending ?? runCell(notebook, cell, parsed.timeout_seconds);
        if (!pending) pendingExecutions.set(executionKey, executionPromise);
        try {
          const run = await executionPromise;
          executionResult = { ...run, ...(pending ? { note: "Returned result from already-pending execution" } : {}) };
        } catch (error) {
          executionResult = { success: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
          if (!pending) pendingExecutions.delete(executionKey);
        }
      }

      const result = {
        cellIndex,
        type: parsed.type,
        language: parsed.type === "code" ? parsed.language : "markdown",
        executed: parsed.execute && parsed.type === "code",
        execution: executionResult
      };

      if (parsed.response_format === ResponseFormat.JSON) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }]
        };
      }

      // Markdown format
      const lines = [`# Cell Inserted`, ""];
      lines.push(`**Index**: ${result.cellIndex}`);
      lines.push(`**Type**: ${result.type}/${result.language}`);

      if (result.executed && executionResult) {
        lines.push("");
        if ("error" in executionResult) {
          lines.push(`**Execution**: Failed - ${executionResult.error}`);
        } else {
          lines.push(`**Execution**: ${describeStatus(executionResult)}${executionResult.executionOrder !== null ? ` (#${executionResult.executionOrder})` : ""}, ran ${describeRanIn(executionResult.ranIn)}`);
          if (executionResult.outputs && executionResult.outputs.length > 0) {
            lines.push("");
            lines.push("## Output");
            lines.push(formatOutputsAsMarkdown(executionResult.outputs));
          }
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }]
      };
    }
  );

  // notebook_edit_cell
  server.tool(
    "notebook_edit_cell",
    `Replace the content of an existing cell.

Args:
  - index (number): Cell index (0-based)
  - content (string): New content for the cell
  - response_format ('markdown' | 'json'): Output format`,
    EditCellInputSchema.shape,
    async (params) => {
      const parsed = EditCellInputSchema.parse(params);
      const accessCheck = await checkCanModifyNotebook(parsed.notebook_uri);
      if (!accessCheck.allowed) {
        return { content: [{ type: "text" as const, text: `Error: ${accessCheck.error}` }], isError: true };
      }

      const notebook = accessCheck.notebook!;

      if (parsed.index >= notebook.cellCount) {
        return { content: [{ type: "text" as const, text: `Error: Cell index ${parsed.index} out of range.` }], isError: true };
      }

      const cell = notebook.cellAt(parsed.index);
      await editCellContent(cell, parsed.content);

      const result = { index: parsed.index, updated: true };

      if (parsed.response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
      return { content: [{ type: "text" as const, text: `Updated cell ${parsed.index}` }] };
    }
  );

  // notebook_delete_cell
  server.tool(
    "notebook_delete_cell",
    `Delete a cell from the notebook.

Args:
  - index (number): Cell index to delete (0-based)
  - response_format ('markdown' | 'json'): Output format`,
    DeleteCellInputSchema.shape,
    async (params) => {
      const parsed = DeleteCellInputSchema.parse(params);
      const accessCheck = await checkCanModifyNotebook(parsed.notebook_uri);
      if (!accessCheck.allowed) {
        return { content: [{ type: "text" as const, text: `Error: ${accessCheck.error}` }], isError: true };
      }

      const notebook = accessCheck.notebook!;

      if (parsed.index >= notebook.cellCount) {
        return { content: [{ type: "text" as const, text: `Error: Cell index ${parsed.index} out of range.` }], isError: true };
      }

      await deleteCells(notebook.uri, parsed.index, 1);

      const result = { deletedIndex: parsed.index, newCellCount: notebook.cellCount };

      if (parsed.response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
      return { content: [{ type: "text" as const, text: `Deleted cell ${parsed.index}. New cell count: ${notebook.cellCount}` }] };
    }
  );

  // notebook_get_outline
  server.tool(
    "notebook_get_outline",
    `Get a structured outline of the notebook showing markdown headings, function definitions, and class definitions.

Useful for navigating large notebooks without reading all cell contents.`,
    GetOutlineInputSchema.shape,
    async (params) => {
      const target = await checkCanReadNotebook(GetOutlineInputSchema.parse(params).notebook_uri);
      if (!target.allowed) {
        return { content: [{ type: "text" as const, text: `Error: ${target.error}` }], isError: true };
      }
      const notebook = target.notebook!;

      const { response_format } = GetOutlineInputSchema.parse(params);
      const outline: Array<{
        cellIndex: number;
        cellType: string;
        lineCount: number;
        items: Array<{ type: string; level?: number; name: string; line: number }>;
      }> = [];

      for (const cell of notebook.getCells()) {
        const text = cell.document.getText();
        const lines = text.split("\n");
        const items: Array<{ type: string; level?: number; name: string; line: number }> = [];

        if (cell.kind === vscode.NotebookCellKind.Markup) {
          // Extract markdown headings
          lines.forEach((line, lineNum) => {
            const match = line.match(/^(#{1,6})\s+(.+)$/);
            if (match) {
              items.push({ type: "heading", level: match[1].length, name: match[2].trim(), line: lineNum });
            }
          });
        } else {
          // Extract Python functions and classes
          lines.forEach((line, lineNum) => {
            const funcMatch = line.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
            const classMatch = line.match(/^class\s+(\w+)/);
            if (funcMatch) {
              items.push({ type: "function", name: funcMatch[1], line: lineNum });
            } else if (classMatch) {
              items.push({ type: "class", name: classMatch[1], line: lineNum });
            }
          });
        }

        outline.push({
          cellIndex: cell.index,
          cellType: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
          lineCount: lines.length,
          items
        });
      }

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ outline }, null, 2) }] };
      }

      // Markdown format
      const output = ["# Notebook Outline", ""];
      for (const entry of outline) {
        if (entry.items.length > 0) {
          for (const item of entry.items) {
            const icon = item.type === "heading" ? "#".repeat(item.level || 1)
                       : item.type === "class" ? "📦" : "🔧";
            output.push(`${icon} **${item.name}** (cell ${entry.cellIndex}:${item.line})`);
          }
        }
      }
      if (output.length === 2) output.push("_No headings, functions, or classes found._");

      return { content: [{ type: "text" as const, text: output.join("\n") }] };
    }
  );

  // notebook_search
  server.tool(
    "notebook_search",
    `Search all cells for a keyword and return matches with context.

Args:
  - query (string): Search term
  - case_sensitive (boolean): Case-sensitive search (default: false)
  - context_lines (number): Lines of context around matches (0-3, default: 1)
  - response_format ('markdown' | 'json'): Output format`,
    SearchInputSchema.shape,
    async (params) => {
      const target = await checkCanReadNotebook(SearchInputSchema.parse(params).notebook_uri);
      if (!target.allowed) {
        return { content: [{ type: "text" as const, text: `Error: ${target.error}` }], isError: true };
      }
      const notebook = target.notebook!;

      const { query, case_sensitive, context_lines, response_format } = SearchInputSchema.parse(params);
      const results: Array<{
        cellIndex: number;
        cellType: string;
        matches: Array<{ line: number; text: string; context?: string[] }>;
      }> = [];

      for (const cell of notebook.getCells()) {
        const text = cell.document.getText();
        const lines = text.split("\n");
        const searchQuery = case_sensitive ? query : query.toLowerCase();
        const cellMatches: Array<{ line: number; text: string; context?: string[] }> = [];

        lines.forEach((line, lineNum) => {
          const lineToSearch = case_sensitive ? line : line.toLowerCase();
          if (lineToSearch.includes(searchQuery)) {
            const match: { line: number; text: string; context?: string[] } = {
              line: lineNum,
              text: line.trim().substring(0, 100)
            };
            if (context_lines > 0) {
              const start = Math.max(0, lineNum - context_lines);
              const end = Math.min(lines.length, lineNum + context_lines + 1);
              match.context = lines.slice(start, end);
            }
            cellMatches.push(match);
          }
        });

        if (cellMatches.length > 0) {
          results.push({
            cellIndex: cell.index,
            cellType: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
            matches: cellMatches
          });
        }
      }

      const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ query, totalMatches, results }, null, 2) }] };
      }

      // Markdown format
      const output = [`# Search: "${query}"`, "", `**${totalMatches}** matches in **${results.length}** cells`, ""];
      for (const r of results) {
        output.push(`## Cell ${r.cellIndex} (${r.cellType})`);
        for (const m of r.matches) {
          output.push(`- Line ${m.line}: \`${m.text}\``);
          if (m.context) {
            output.push("```", ...m.context, "```");
          }
        }
      }
      if (results.length === 0) output.push("_No matches found._");

      return { content: [{ type: "text" as const, text: output.join("\n") }] };
    }
  );

  // notebook_clear_outputs
  server.tool(
    "notebook_clear_outputs",
    `Clear the outputs of a specific cell.

Args:
  - index (number): Cell index (0-based)`,
    ClearOutputsInputSchema.shape,
    async (params) => {
      const parsed = ClearOutputsInputSchema.parse(params);
      const accessCheck = await checkCanModifyNotebook(parsed.notebook_uri);
      if (!accessCheck.allowed) {
        return { content: [{ type: "text" as const, text: `Error: ${accessCheck.error}` }], isError: true };
      }

      const { index, response_format } = parsed;
      if (index >= accessCheck.notebook!.cellCount) {
        return { content: [{ type: "text" as const, text: `Error: Cell index ${index} out of range.` }], isError: true };
      }

      await clearCellOutputs(accessCheck.notebook!, [index]);

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ index, cleared: true }, null, 2) }] };
      }
      return { content: [{ type: "text" as const, text: `Cleared outputs for cell ${index}` }] };
    }
  );

  // notebook_clear_all_outputs
  server.tool(
    "notebook_clear_all_outputs",
    `Clear outputs from all cells in the notebook.`,
    { response_format: ResponseFormatSchema, notebook_uri: NotebookUriSchema },
    async (params) => {
      const parsed = z.object({ response_format: ResponseFormatSchema, notebook_uri: NotebookUriSchema }).parse(params);
      const accessCheck = await checkCanModifyNotebook(parsed.notebook_uri);
      if (!accessCheck.allowed) {
        return { content: [{ type: "text" as const, text: `Error: ${accessCheck.error}` }], isError: true };
      }

      await clearCellOutputs(accessCheck.notebook!, accessCheck.notebook!.getCells().map((c) => c.index));

      if (parsed.response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ cleared: true, cellCount: accessCheck.notebook!.cellCount }, null, 2) }] };
      }
      return { content: [{ type: "text" as const, text: `Cleared outputs from all ${accessCheck.notebook!.cellCount} cells` }] };
    }
  );

  // notebook_move_cell
  server.tool(
    "notebook_move_cell",
    `Move a cell to a different position in the notebook.

Args:
  - from_index (number): Current cell index
  - to_index (number): Target position`,
    MoveCellInputSchema.shape,
    async (params) => {
      const parsed = MoveCellInputSchema.parse(params);
      const accessCheck = await checkCanModifyNotebook(parsed.notebook_uri);
      if (!accessCheck.allowed) {
        return { content: [{ type: "text" as const, text: `Error: ${accessCheck.error}` }], isError: true };
      }

      const { from_index, to_index, response_format } = parsed;
      const notebook = accessCheck.notebook!;

      if (from_index >= notebook.cellCount || to_index >= notebook.cellCount) {
        return { content: [{ type: "text" as const, text: "Error: Cell index out of range." }], isError: true };
      }

      if (from_index === to_index) {
        return { content: [{ type: "text" as const, text: "Cell already at target position." }] };
      }

      await moveCell(notebook, from_index, to_index);

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ from: from_index, to: to_index, moved: true }, null, 2) }] };
      }
      return { content: [{ type: "text" as const, text: `Moved cell from ${from_index} to ${to_index}` }] };
    }
  );

  // notebook_bulk_add_cells
  server.tool(
    "notebook_bulk_add_cells",
    `Add multiple cells to the notebook in a single operation.

Args:
  - cells (array): Array of {content, type, language} objects
  - index (number, optional): Position to insert (default: append at end)`,
    BulkAddCellsInputSchema.shape,
    async (params) => {
      const parsed = BulkAddCellsInputSchema.parse(params);
      const accessCheck = await checkCanModifyNotebook(parsed.notebook_uri);
      if (!accessCheck.allowed) {
        return { content: [{ type: "text" as const, text: `Error: ${accessCheck.error}` }], isError: true };
      }

      const { cells, index, response_format } = parsed;
      const notebook = accessCheck.notebook!;
      const insertIndex = index !== undefined ? Math.min(index, notebook.cellCount) : notebook.cellCount;

      const cellDataArray = cells.map(c => {
        const kind = c.type === "code" ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup;
        const lang = c.type === "code" ? c.language : "markdown";
        return new vscode.NotebookCellData(kind, c.content, lang);
      });

      await insertCells(notebook.uri, insertIndex, cellDataArray);

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text" as const, text: JSON.stringify({
          inserted: cells.length,
          startIndex: insertIndex,
          newCellCount: notebook.cellCount
        }, null, 2) }] };
      }
      return { content: [{ type: "text" as const, text: `Added ${cells.length} cells at index ${insertIndex}` }] };
    }
  );

  // notebook_run_cell
  server.tool(
    "notebook_run_cell",
    `Execute an existing cell in the notebook and return its output.

Use this to run a cell that already exists in the notebook. In a notebook on screen it runs in the cell and the output stays in the notebook UI. In a notebook not on screen it runs in that notebook's kernel and the output is only returned to you (call notebook_show first if the user should see it).

Args:
  - index (number): Cell index to execute (0-based)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')`,
    RunCellInputSchema.shape,
    async (params) => {
      const parsed = RunCellInputSchema.parse(params);
      const accessCheck = await checkCanModifyNotebook(parsed.notebook_uri);
      if (!accessCheck.allowed) {
        return {
          content: [{ type: "text" as const, text: `Error: ${accessCheck.error}` }],
          isError: true
        };
      }

      const notebook = accessCheck.notebook!;

      if (parsed.index >= notebook.cellCount) {
        return {
          content: [{ type: "text" as const, text: `Error: Cell index ${parsed.index} out of range (0-${notebook.cellCount - 1}).` }],
          isError: true
        };
      }

      const cell = notebook.cellAt(parsed.index);

      // Only code cells can be executed
      if (cell.kind !== vscode.NotebookCellKind.Code) {
        return {
          content: [{ type: "text" as const, text: `Error: Cell ${parsed.index} is a markdown cell. Only code cells can be executed.` }],
          isError: true
        };
      }

      const executionKey = getExecutionKey(notebook.uri.toString(), parsed.index);

      const pending = pendingExecutions.get(executionKey);
      if (pending) {
        try {
          return formatRun(parsed.index, await pending, parsed.response_format, "Returned result from already-pending execution");
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: `Error: Pending execution failed - ${error instanceof Error ? error.message : String(error)}` }],
            isError: true
          };
        }
      }

      // Already running (started by the user, or an earlier call whose wait ran out): wait on it.
      const running = waitForRunningCell(notebook, cell, parsed.timeout_seconds * 1000);
      if (running) {
        return formatRun(parsed.index, await running, parsed.response_format, "Waited on the run already in progress");
      }

      accessCheck.editor?.revealRange(
        new vscode.NotebookRange(parsed.index, parsed.index + 1),
        vscode.NotebookEditorRevealType.InCenter
      );
      const executionPromise = runCell(notebook, cell, parsed.timeout_seconds);
      pendingExecutions.set(executionKey, executionPromise);
      try {
        return formatRun(parsed.index, await executionPromise, parsed.response_format);
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      } finally {
        pendingExecutions.delete(executionKey);
      }
    }
  );
}
