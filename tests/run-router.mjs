// Stryker突变测试wrapper——确保node:test跑完后立刻退出
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import process from 'node:process';

const stream = run({ files: ['tests/router.test.mjs'] });
stream.compose(spec).pipe(process.stdout);
stream.on('test:fail', () => { process.exitCode = 1; });
stream.once('close', () => setTimeout(() => process.exit(), 100));
