import * as vscode from "vscode";

/** The slice of the Jupyter extension's public API this server uses (ms-toolsai.jupyter `exports`). */
export interface JupyterOutput {
  items: { mime: string; data: Uint8Array }[];
}

export interface JupyterKernel {
  readonly status: string;
  readonly language: string;
  executeCode(code: string, token: vscode.CancellationToken): AsyncIterable<JupyterOutput>;
}

export interface JupyterAPI {
  kernels: {
    /** The kernel already running for this notebook, if any. It never starts one. */
    getKernel(uri: vscode.Uri): Thenable<JupyterKernel | undefined>;
  };
}

let jupyterApiPromise: Promise<JupyterAPI> | undefined;

export function getJupyterAPI(): Promise<JupyterAPI> {
  if (!jupyterApiPromise) {
    const ext = vscode.extensions.getExtension<JupyterAPI>("ms-toolsai.jupyter");
    if (!ext) {
      return Promise.reject(new Error("Jupyter extension not installed"));
    }
    jupyterApiPromise = Promise.resolve(ext.activate());
  }
  return jupyterApiPromise;
}
