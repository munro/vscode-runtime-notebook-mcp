import { describe, expect, it } from 'vitest';
import type { JupyterKernel, JupyterOutput } from './jupyter.js';
import { runInKernel } from './run.js';

const bytes = (s: string) => new TextEncoder().encode(s);

function fakeKernel(outputs: JupyterOutput[], seen: string[] = []): JupyterKernel {
  return {
    status: 'idle',
    language: 'python',
    async *executeCode(code: string) {
      seen.push(code);
      for (const o of outputs) yield o;
    }
  };
}

describe('runInKernel (notebook not on screen)', () => {
  it('sends the cell code to the kernel and returns its output', async () => {
    const seen: string[] = [];
    const run = await runInKernel(
      fakeKernel([{ items: [{ mime: 'application/vnd.code.notebook.stdout', data: bytes('hello\n') }] }, { items: [{ mime: 'text/plain', data: bytes('5050') }] }], seen),
      'print("hello")\nsum(range(1, 101))',
      60_000
    );
    expect(seen).toEqual(['print("hello")\nsum(range(1, 101))']);
    expect(run).toMatchObject({ status: 'done', success: true, ranIn: 'kernel', executionOrder: null });
    expect(run.outputs).toEqual([
      { type: 'text', text: 'hello\n' },
      { type: 'text', text: '5050' }
    ]);
  });

  it('marks the run failed when the kernel reports an error', async () => {
    const err = JSON.stringify({ name: 'NameError', message: "name 'np' is not defined", stack: '' });
    const run = await runInKernel(fakeKernel([{ items: [{ mime: 'application/vnd.code.notebook.error', data: bytes(err) }] }]), 'np', 60_000);
    expect(run.success).toBe(false);
    expect(run.outputs[0]).toMatchObject({ type: 'error', name: 'NameError' });
  });

  it('succeeds with no output', async () => {
    const run = await runInKernel(fakeKernel([]), 'x = 1', 60_000);
    expect(run).toMatchObject({ success: true, outputs: [] });
  });

  it('reports a run past its timeout as still running, with the output so far', async () => {
    const slow: JupyterKernel = {
      status: 'busy',
      language: 'python',
      async *executeCode(_code: string, token: { isCancellationRequested: boolean }) {
        yield { items: [{ mime: 'application/vnd.code.notebook.stdout', data: bytes('step 1\n') }] };
        while (!token.isCancellationRequested) await new Promise((r) => setTimeout(r, 5));
      }
    };
    const run = await runInKernel(slow, 'long()', 30);
    expect(run).toMatchObject({ status: 'running', success: false, ranIn: 'kernel' });
    expect(run.outputs).toEqual([{ type: 'text', text: 'step 1\n' }]);
  });
});
