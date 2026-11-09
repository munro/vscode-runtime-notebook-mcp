import * as vscode from "vscode";
import { CellOutput, parseOutputs } from "./output.js";
import { finishedSince } from "./notebook.js";
import { getJupyterAPI, JupyterKernel } from "./jupyter.js";

/**
 * Where a run happens.
 * - "cell": VS Code runs the cell; its output and execution count appear under it.
 * - "kernel": the notebook is not on screen, so the cell's code goes straight to that notebook's
 *   kernel. Output comes back to the caller but is not shown under the cell (only the kernel's
 *   owner can write cell outputs).
 */
export type RanIn = "cell" | "kernel";

export interface RunResult {
  success: boolean;
  executionOrder: number | null;
  outputs: CellOutput[];
  ranIn: RanIn;
}

const RUN_TIMEOUT_MS = 60_000;

export const SHOW_TO_RUN_SETTING = "showNotebookToRun";

const isVisible = (notebook: vscode.NotebookDocument) =>
  vscode.window.visibleNotebookEditors.some((e) => e.notebook.uri.toString() === notebook.uri.toString());

/**
 * `notebook.cell.execute` resolves `document` among visible editor panes and silently falls back
 * to the active one, so it may only be used on a visible notebook: on a hidden one it runs the
 * same cell index in whatever notebook is in front.
 */
async function chooseRunPlace(notebook: vscode.NotebookDocument): Promise<RanIn> {
  if (isVisible(notebook)) return "cell";
  const show = vscode.workspace.getConfiguration("notebook-mcp").get<boolean>(SHOW_TO_RUN_SETTING, false);
  if (show) {
    await vscode.window.showNotebookDocument(notebook, { preserveFocus: true, preview: false });
    if (isVisible(notebook)) return "cell";
  }
  return "kernel";
}

async function runInCell(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell): Promise<RunResult> {
  const since = Date.now();
  const orderBefore = cell.executionSummary?.executionOrder;
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [{ start: cell.index, end: cell.index + 1 }],
    document: notebook.uri
  });
  const deadline = since + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = notebook.cellAt(cell.index);
    if (finishedSince(current, since, orderBefore)) {
      return {
        success: current.executionSummary?.success ?? false,
        executionOrder: current.executionSummary?.executionOrder ?? null,
        outputs: parseOutputs(current.outputs),
        ranIn: "cell"
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Cell execution timed out");
}

const ERROR_MIME = vscode.NotebookCellOutputItem.error(new Error("")).mime;

export async function runInKernel(kernel: JupyterKernel, code: string): Promise<RunResult> {
  const source = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => source.cancel(), RUN_TIMEOUT_MS);
  const outputs: vscode.NotebookCellOutput[] = [];
  try {
    for await (const out of kernel.executeCode(code, source.token)) {
      outputs.push(new vscode.NotebookCellOutput(out.items.map((i) => new vscode.NotebookCellOutputItem(i.data, i.mime))));
    }
  } finally {
    clearTimeout(timer);
    source.dispose();
  }
  if (source.token.isCancellationRequested) {
    throw new Error("Cell execution timed out");
  }
  const failed = outputs.some((o) => o.items.some((i) => i.mime === ERROR_MIME));
  return { success: !failed, executionOrder: null, outputs: parseOutputs(outputs), ranIn: "kernel" };
}

/** Run one code cell of `notebook`, in the cell when it is on screen, else in its kernel. */
export async function runCell(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell): Promise<RunResult> {
  if ((await chooseRunPlace(notebook)) === "cell") {
    return runInCell(notebook, cell);
  }
  const kernel = await (await getJupyterAPI()).kernels.getKernel(notebook.uri);
  if (!kernel) {
    throw new Error(
      `${notebook.uri.fsPath} is not on screen and has no running kernel, so there is nothing to run it in. ` +
        "Call notebook_show to bring it into view, then run again (that starts its kernel)."
    );
  }
  return runInKernel(kernel, cell.document.getText());
}

export function describeRanIn(ranIn: RanIn): string {
  return ranIn === "cell"
    ? "in the cell"
    : "in the notebook's kernel (not on screen, so the output is not shown under the cell; notebook_show brings it into view)";
}
