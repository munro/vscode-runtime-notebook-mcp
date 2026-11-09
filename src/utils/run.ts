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

/** "done": the run ended. "running": the wait ran out while the cell is still executing. */
export type RunStatus = "done" | "running";

export interface RunResult {
  status: RunStatus;
  /** Meaningful only when status is "done". */
  success: boolean;
  executionOrder: number | null;
  /** Everything the cell has printed so far when status is "running". */
  outputs: CellOutput[];
  ranIn: RanIn;
}

export const DEFAULT_TIMEOUT_SECONDS = 60;
export const MAX_TIMEOUT_SECONDS = 3600;

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

const isExecuting = (cell: vscode.NotebookCell) => {
  const timing = cell.executionSummary?.timing;
  return timing !== undefined && timing.startTime !== undefined && timing.endTime === undefined;
};

const startedSince = (cell: vscode.NotebookCell, since: number) => (cell.executionSummary?.timing?.startTime ?? 0) >= since;

function cellResult(cell: vscode.NotebookCell, status: RunStatus): RunResult {
  return {
    status,
    success: status === "done" && (cell.executionSummary?.success ?? false),
    executionOrder: cell.executionSummary?.executionOrder ?? null,
    outputs: parseOutputs(cell.outputs),
    ranIn: "cell"
  };
}

/** Poll until `done(cell)`, or the deadline; then report the run as still going if it is. */
async function waitInCell(
  notebook: vscode.NotebookDocument,
  index: number,
  timeoutMs: number,
  done: (cell: vscode.NotebookCell) => boolean,
  neverStarted: (cell: vscode.NotebookCell) => boolean
): Promise<RunResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = notebook.cellAt(index);
    if (done(current)) return cellResult(current, "done");
    if (Date.now() >= deadline) {
      if (neverStarted(current)) {
        throw new Error(
          `Cell ${index} did not start within ${Math.round(timeoutMs / 1000)}s. VS Code may be waiting for a kernel to be picked for this notebook.`
        );
      }
      return cellResult(current, "running");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runInCell(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell, timeoutMs: number): Promise<RunResult> {
  const since = Date.now();
  const orderBefore = cell.executionSummary?.executionOrder;
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [{ start: cell.index, end: cell.index + 1 }],
    document: notebook.uri
  });
  return waitInCell(
    notebook,
    cell.index,
    timeoutMs,
    (c) => finishedSince(c, since, orderBefore),
    (c) => !startedSince(c, since) && !isExecuting(c)
  );
}

/** Wait on a run already in progress in the cell (started by the user or an earlier call). */
export function waitForRunningCell(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell, timeoutMs: number): Promise<RunResult> | undefined {
  if (!isExecuting(cell)) return undefined;
  return waitInCell(notebook, cell.index, timeoutMs, (c) => !isExecuting(c) && typeof c.executionSummary?.success === "boolean", () => false);
}

const ERROR_MIME = vscode.NotebookCellOutputItem.error(new Error("")).mime;

/**
 * Run code in a kernel directly. On timeout the wait is cancelled and the run reported as still
 * going: with no cell to watch there is no way to pick it up again, so the caller is told to
 * interrupt it if it should stop.
 */
export async function runInKernel(kernel: JupyterKernel, code: string, timeoutMs: number): Promise<RunResult> {
  const source = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => source.cancel(), timeoutMs);
  const outputs: vscode.NotebookCellOutput[] = [];
  try {
    for await (const out of kernel.executeCode(code, source.token)) {
      outputs.push(new vscode.NotebookCellOutput(out.items.map((i) => new vscode.NotebookCellOutputItem(i.data, i.mime))));
      if (source.token.isCancellationRequested) break;
    }
  } finally {
    clearTimeout(timer);
    source.dispose();
  }
  const status: RunStatus = source.token.isCancellationRequested ? "running" : "done";
  const failed = outputs.some((o) => o.items.some((i) => i.mime === ERROR_MIME));
  return { status, success: status === "done" && !failed, executionOrder: null, outputs: parseOutputs(outputs), ranIn: "kernel" };
}

/** Run one code cell of `notebook`, in the cell when it is on screen, else in its kernel. */
export async function runCell(
  notebook: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
  timeoutSeconds: number = DEFAULT_TIMEOUT_SECONDS
): Promise<RunResult> {
  const timeoutMs = timeoutSeconds * 1000;
  if ((await chooseRunPlace(notebook)) === "cell") {
    return runInCell(notebook, cell, timeoutMs);
  }
  const kernel = await (await getJupyterAPI()).kernels.getKernel(notebook.uri);
  if (!kernel) {
    throw new Error(
      `${notebook.uri.fsPath} is not on screen and has no running kernel, so there is nothing to run it in. ` +
        "Call notebook_show to bring it into view, then run again (that starts its kernel)."
    );
  }
  return runInKernel(kernel, cell.document.getText(), timeoutMs);
}

export function describeRanIn(ranIn: RanIn): string {
  return ranIn === "cell"
    ? "in the cell"
    : "in the notebook's kernel (not on screen, so the output is not shown under the cell; notebook_show brings it into view)";
}

export function describeStatus(run: RunResult): string {
  if (run.status === "running") {
    return run.ranIn === "cell"
      ? "Still running (the wait ran out; call notebook_run_cell on this cell again to keep waiting, or notebook_interrupt_kernel to stop it)"
      : "Still running in the kernel (the wait ran out and this run cannot be picked up again; notebook_interrupt_kernel stops it)";
  }
  return run.success ? "Success" : "Failed";
}
