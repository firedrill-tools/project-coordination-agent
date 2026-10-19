import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApplicationError, commandMain, invokeCLI, privateDirectory } from './adapter-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cases = new Set(['starter', 'busy', 'ambiguous-owner']);

export async function runApplication(input, parameters, signal) {
  if (Object.keys(input).some(key => !['caseId', 'task', 'allowWrites'].includes(key)) || !cases.has(input.caseId) ||
      typeof input.task !== 'string' || !input.task.trim() || input.task.length > 8000 || input.task.includes('\0') ||
      typeof input.allowWrites !== 'boolean') {
    throw new Error('Select a reviewed case, bounded task and explicit independent boolean write permission.');
  }
  const directory = await privateDirectory(root);
  const state = join(directory, 'workspace.json');
  const cli = [process.execPath, 'dist/src/cli.js'];
  try {
    await invokeCLI([...cli, 'init', '--case', input.caseId, '--state', state], { cwd: root, signal });
    const argv = [...cli, 'run', '--state', state, '--task', input.task,
      '--request-id', randomUUID(), '--output-root', join(directory, 'evidence')];
    if (input.allowWrites) argv.push('--allow-writes');
    if (parameters.model) argv.push('--model', parameters.model);
    const output = await invokeCLI(argv, { cwd: root, signal, timeoutMs: 270000 });
    return { application: output, localState: { directory, workspaceFile: state } };
  } catch (error) {
    if (error instanceof ApplicationError) error.evidence.runDirectory = directory;
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await commandMain(runApplication);
}
