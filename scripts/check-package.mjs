import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'firedrill-coordinator-package-'));
const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.NODE_TEST_CONTEXT;
// npm run exports user settings as environment settings; npm 12 rejects this
// particular install setting at environment scope. Preserve the user's config.
for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
const run = (command, args, cwd) => execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 4_194_304, stdio: ['ignore','pipe','pipe'] });
try {
  run('npm', ['run','build'], root);
  const archive = path.join(temporary, 'source.tar.gz'); run(process.execPath, ['scripts/package.mjs', archive], root);
  const entries = run('tar', ['-tzf', archive], temporary).split('\n');
  if (!entries.includes('package/firedrill/package-lock.json') || entries.some(name => name.includes('/node_modules/') || name.includes('/.runs/'))) throw new Error('optional execution toolchain source missing or contains installed/private state');
  run('tar', ['-xzf', archive, '-C', temporary], temporary);
  const directory = path.join(temporary, 'package'), cli = path.join(directory, 'dist/src/cli.js');
  if (!fs.existsSync(path.join(directory, 'package-lock.json'))) throw new Error('archive lacks locked dependencies');
  run('npm', ['ci','--ignore-scripts','--no-audit','--no-fund'], directory);
  // Apply the repository's existing, guarded root postinstall explicitly after
  // skipping dependency install scripts; this is required by its parser contract.
  run(process.execPath, ['scripts/patch-argparse.cjs'], directory);
  run('npm', ['run','build'], directory); run(process.execPath, [cli,'--help'], temporary);
  run('npm', ['ci','--prefix','firedrill','--ignore-scripts','--no-audit','--no-fund'], directory);
  run('npm', ['test','--prefix','firedrill'], directory);
  const manifest = JSON.parse(run(process.execPath, [cli,'list'], temporary));
  if (manifest.cases.length !== 8) throw new Error('packaged dataset list differs');
  for (const item of manifest.cases) {
    const file = path.join(temporary, `${item.id}.json`);
    const selected = JSON.parse(run(process.execPath, [cli,'init','--case',item.id,'--state',file], temporary));
    if (selected.dataset.caseId !== item.id || (fs.statSync(file).mode & 0o777) !== 0o600) throw new Error('packaged initialization differs');
  }
  const result = spawnSync(process.execPath, [cli,'run','--state',path.join(temporary,'starter.json'),'--task','Inspect the exact invite issue','--output-root',path.join(temporary,'runs')], { cwd: temporary, env, encoding: 'utf8', timeout: 15000 });
  if (result.status !== 1 || !result.stderr.includes('ANTHROPIC_API_KEY is required')) throw new Error('packaged key preflight failed');
  const workspaceModule = pathToFileURL(path.join(directory,'dist/src/workspace.js')).href;
  const program = `const {Workspace,loadState}=await import(process.argv[1]); const file=process.argv[2]; const before=loadState(file); const store=new Workspace(file); if(store.findIssues('N-103','northstar/web-app')[0]?.revision!==2)throw Error('packaged ID search failed'); const result=store.updateIssue('N-103','done',2,'package-check'); if(!result.ok||result.data.revision!==3)throw Error('packaged update failed'); if(loadState(file).posts.length!==12||before.issues.length!==18)throw Error('packaged history differs');`;
  run(process.execPath, ['--input-type=module','-e',program,workspaceModule,path.join(temporary,'busy.json')], temporary);
  console.log('Locked archive verified outside checkout: build, parser repair, CLI/help/list, eight private cases, key preflight and real ID/revision operations.');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
