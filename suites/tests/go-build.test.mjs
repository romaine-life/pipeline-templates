import test from 'node:test';
import assert from 'node:assert/strict';
import {mingwRuntimeImports, stamped} from '../go/build.mjs';

// objdump -p's import table, as it prints a cgo DLL's.
const imports = names => names.map(name => `\tDLL Name: ${name}\n\tvma:  Hint/Ord Member-Name Bound-To\n`).join('\n');

test('a cgo DLL that needs a MinGW runtime DLL is refused, the Windows and UCRT ones pass', () => {
  assert.deepEqual(mingwRuntimeImports(imports(['KERNEL32.dll', 'api-ms-win-crt-heap-l1-1-0.dll', 'api-ms-win-crt-runtime-l1-1-0.dll'])), []);
  assert.deepEqual(mingwRuntimeImports(imports(['KERNEL32.dll', 'libwinpthread-1.dll', 'LIBGCC_S_SEH-1.DLL'])), ['libwinpthread-1.dll', 'LIBGCC_S_SEH-1.DLL']);
});

test('objdump output with no imports is an error, not a pass', () => {
  assert.throws(() => mingwRuntimeImports('fzt.dll:     file format pei-x86-64\n'), /no imports/);
});

test("a release's Go build carries its VERSION, not just the ldflags text naming it", () => {
  assert.equal(stamped(Buffer.from('\0\0v1.2.3\0'), 'v1.2.3'), true);
  assert.equal(stamped(Buffer.from('\0\0v1.2.4\0'), 'v1.2.3'), false);
  // Built without -trimpath, a binary records its -ldflags, the -X that set nothing included.
  assert.equal(stamped(Buffer.from('build\t-ldflags="-s -w -X main.version=v1.2.3"\n'), 'v1.2.3'), false);
  assert.equal(stamped(Buffer.from('v1.2.3\0build\t-ldflags="-X=main.version=v1.2.3"\n'), 'v1.2.3'), true);
});
