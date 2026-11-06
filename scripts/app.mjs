import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const root = process.cwd();
const env = { ...process.env };
const children = [];

async function loadEnv() {
  try {
    const contents = await readFile(path.join(root, '.env'), 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
      if (match && !match[1].startsWith('#')) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch (error) {
    throw new Error('Missing .env; copy .env.example to .env before starting LedgerLine.');
  }
}

async function command(file, args) {
  await exec(file, args, { cwd: root, env, windowsHide: true });
}

const npmShell = (...args) => [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`]];

function start(commandName, args, label, cwd = root) {
  const child = spawn(commandName, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: commandName.endsWith('.cmd') });
  let output = '';
  child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-4000); });
  child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-4000); });
  child.on('exit', code => { if (code && !shuttingDown) console.error(`${label} exited with code ${code}.\n${output}`); });
  children.push(child);
  return child;
}

async function waitFor(url, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

let shuttingDown = false;
async function shutdown(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill(signal);
}
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

try {
  await loadEnv();
  await command('docker', ['compose', 'up', '-d', '--wait', 'postgres']);
  const [migrationShell, migrationArgs] = npmShell('run', 'db:migrate');
  await command(migrationShell, migrationArgs);
  const [shell, backendArgs] = npmShell('run', 'dev:backend');
  const [, frontendArgs] = npmShell('run', 'dev:frontend', '--', '--host', '127.0.0.1');
  start(shell, ['/d', '/s', '/c', 'npm run dev'], 'Backend', path.join(root, 'backend'));
  start(shell, ['/d', '/s', '/c', 'npm run dev -- --host 127.0.0.1'], 'Frontend', path.join(root, 'frontend'));
  await waitFor(`http://127.0.0.1:${env.PORT ?? '3000'}/health`, 'Backend');
  await waitFor('http://127.0.0.1:5173', 'Frontend');
  console.log('LedgerLine services are ready.');
  console.log('Frontend: http://localhost:5173');
  await new Promise(() => {});
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await shutdown();
  process.exitCode = 1;
}
