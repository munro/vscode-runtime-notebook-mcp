// Mock VS Code API for testing
export class NotebookCellOutputItem {
  constructor(public data: Uint8Array, public mime: string) {}
  static error(_err: Error) {
    return { mime: 'application/vnd.code.notebook.error' };
  }
}

export class NotebookCellOutput {
  constructor(public items: NotebookCellOutputItem[]) {}
}

export class CancellationTokenSource {
  token = { isCancellationRequested: false };
  cancel() {
    this.token.isCancellationRequested = true;
  }
  dispose() {}
}

export const NotebookEdit = {
  insertCells: () => ({}),
  deleteCells: () => ({})
};

export class NotebookRange {
  constructor(public start: number, public end: number) {}
}

export class Uri {
  static file(path: string) {
    return { path, scheme: 'file' };
  }
}

export class WorkspaceEdit {
  set() {}
}

export const workspace = {
  applyEdit: async () => true
};

export const NotebookCellKind = {
  Code: 1,
  Markup: 2
};

// Window state for multi-window tests
export const window = {
  activeNotebookEditor: undefined as any,
  state: { focused: true }
};

