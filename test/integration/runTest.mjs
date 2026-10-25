// Launches a real VS Code with the extension loaded and runs suite.cjs inside it.
import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
await runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: join(root, 'test', 'integration', 'suite.cjs'),
  launchArgs: [join(root, 'samples'), '--disable-extensions', '--disable-workspace-trust'],
});
