# Windows Development Rules

## Paths

```ts
import path from 'node:path';
import envPaths from 'env-paths';

const paths = envPaths('smart-sniper', { suffix: '' });
// paths.data    → %APPDATA%\smart-sniper
// paths.config  → %APPDATA%\smart-sniper
// paths.cache   → %LOCALAPPDATA%\smart-sniper
// paths.log     → %LOCALAPPDATA%\smart-sniper\Log

// always use path.join, never string concat
const dbPath = path.join(paths.data, 'app.db');
```

## Long Path Check

On startup:
```ts
function checkLongPathSupport(): void {
  if (process.platform !== 'win32') return;
  // probe a 300-char path; if ENAMETOOLONG, prompt user to enable long paths
}
```

## IPC Path Builder

```ts
function buildIpcPath(name: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\smartsniper-${name}`
    : path.join(os.tmpdir(), `smartsniper-${name}.sock`);
}
```

## Encoding

```ts
// startup
process.env.LANG = process.env.LANG ?? 'en_US.UTF-8';

// every file I/O explicit
fs.readFileSync(p, 'utf8');
fs.writeFileSync(p, data, 'utf8');

// every spawn explicit
import { execa } from 'execa';
await execa('node', [script], {
  encoding: 'utf8',
  env: { ...process.env, LANG: 'en_US.UTF-8' },
});
```

## SIGINT

```ts
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
if (process.platform === 'win32') {
  readline.createInterface({ input: process.stdin })
    .on('SIGINT', cleanup);
}
```

## SQLite

```ts
const db = new Database(dbPath, { fileMustExist: false, timeout: 5000 });
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
```

Stale lock cleanup at startup:
```ts
function cleanupStaleLocks(dbDir: string): void {
  // check WAL/SHM files; if no active process holds lock, remove
}
```

## Defender / SmartScreen

- M0–M7: development phase, accept warnings
- M8 packaging: evaluate code signing certificate (~$300/year EV)
- Do not pack with UPX (high false-positive rate)

## Playwright

- `PLAYWRIGHT_BROWSERS_PATH` set to bundled location
- Cold start ~30% slower than Linux; prewarm well before Strike

## Forbidden

- `.bat` / `.sh` scripts: cross-platform scripts in Node only
- `cmd.exe` string concat: injection risk
- Assumption: filesystem case-sensitivity
- Assumption: default UTF-8 stdio
- Direct path concat with `/` or `\`
