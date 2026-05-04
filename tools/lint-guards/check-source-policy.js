import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const failures = [];
const allowedFetch = path.join('packages', 'core', 'network-egress');
const allowedCredential = [
  path.join('packages', 'core', 'credential-store'),
  path.join('packages', 'vault')
];

for (const file of walk(root)) {
  const rel = path.relative(root, file);
  if (!rel.endsWith('.js')) continue;
  if (rel.startsWith(path.join('tools', 'lint-guards'))) continue;
  if (rel.startsWith(path.join('packages', 'web-ui'))) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (!rel.startsWith(allowedFetch) && hasBareFetchCall(text)) {
    failures.push(`${rel}: direct fetch is forbidden; use NetworkEgress`);
  }
  if (!allowedCredential.some((prefix) => rel.startsWith(prefix)) && /keyring|keychain|CredentialManager/i.test(text)) {
    failures.push(`${rel}: raw keychain access is forbidden; use CredentialStore/Vault`);
  }
  if (/mobile-ios/.test(text)) {
    failures.push(`${rel}: iOS automation must not be introduced`);
  }
  if (rel.startsWith(path.join('packages', 'core', 'scheduler'))) {
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (line.includes('Date.now()') && !line.includes('clock = () => Date.now()')) {
        failures.push(`${rel}:${index + 1}: scheduler trigger decisions must use injected/server time, not Date.now()`);
      }
    }
  }
  if (rel.startsWith(path.join('packages', 'server')) && hasMachineContextMutation(text)) {
    failures.push(`${rel}: services must not mutate machine.context directly; use machine.send(..., patch)`);
  }
  if (rel.startsWith(path.join('packages', 'adapters', 'sites'))) {
    // (N1) sites/*.js may only import from ../_base/... or sibling sites/. Forbid
    // any reach into core/, server/, vault/, mobile-bridge/, _template/.
    for (const m of text.matchAll(/import\s+(?:[\w*{}\s,]+)\s+from\s+['"]([^'"]+)['"]/g)) {
      const importPath = m[1];
      const okBase = importPath.startsWith('../_base/');
      const okSibling = importPath.startsWith('./');
      if (!okBase && !okSibling) {
        failures.push(`${rel}: site files may only import from '../_base/...' or './' siblings (got '${importPath}')`);
      }
    }
    // (N2) no direct egress.fetch / process.* / vault / keychain in sites/.
    if (/\.fetch\s*\(/.test(text)) {
      failures.push(`${rel}: site files must not call .fetch directly; route through _base adapters`);
    }
    if (/\bprocess\s*\.\s*(?:env|argv|exit|stdin|stdout|stderr|cwd)/.test(text)) {
      failures.push(`${rel}: site files must not use process.* APIs`);
    }
    if (/\b(?:vault|keyring|keychain|CredentialManager)\b/i.test(text)) {
      failures.push(`${rel}: site files must not access vault / keychain directly`);
    }
    // (N3) class extends Base*Adapter requires @override-reason JSDoc.
    if (/class\s+\w+\s+extends\s+Base\w+Adapter\b/.test(text) && !/@override-reason\b/.test(text)) {
      failures.push(`${rel}: class extends Base*Adapter requires JSDoc @override-reason explaining why config + hooks are insufficient`);
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('source policy checks passed');

function hasBareFetchCall(text) {
  if (/\bglobalThis\s*\.\s*fetch\s*\(/.test(text)) return true;
  return text.split(/\r?\n/).some((line) => {
    if (!/(^|[^\w.])fetch\s*\(/.test(line)) return false;
    if (/^\s*(async\s+)?fetch\s*\(/.test(line)) return false;
    return true;
  });
}

function hasMachineContextMutation(text) {
  return text.split(/\r?\n/).some((line) => {
    if (/machine\.context\s*=/.test(line)) return true;
    if (/machine\.context\.[a-zA-Z0-9_$]+\s*=/.test(line)) return true;
    if (/machine\.context\.[a-zA-Z0-9_$.]+\.(push|pop|splice|shift|unshift|sort|reverse)\s*\(/.test(line)) return true;
    return false;
  });
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'docs'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}
