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
      'print("hello")\nsum(range(1, 101))'
    );
    expect(seen).toEqual(['print("hello")\nsum(range(1, 101))']);
    expect(run).toMatchObject({ success: true, ranIn: 'kernel', executionOrder: null });
    expect(run.outputs).toEqual([
      { type: 'text', text: 'hello\n' },
      { type: 'text', text: '5050' }
    ]);
  });

  it('marks the run failed when the kernel reports an error', async () => {
    const err = JSON.stringify({ name: 'NameError', message: "name 'np' is not defined", stack: '' });
    const run = await runInKernel(fakeKernel([{ items: [{ mime: 'application/vnd.code.notebook.error', data: bytes(err) }] }]), 'np');
    expect(run.success).toBe(false);
    expect(run.outputs[0]).toMatchObject({ type: 'error', name: 'NameError' });
  });

  it('succeeds with no output', async () => {
    const run = await runInKernel(fakeKernel([]), 'x = 1');
    expect(run).toMatchObject({ success: true, outputs: [] });
  });
});
