import test from 'node:test';
import assert from 'node:assert/strict';
import {mingwRuntimeImports} from '../go/build.mjs';

// objdump -p's import table, as it prints a cgo DLL's.
const imports = names => names.map(name => `\tDLL Name: ${name}\n\tvma:  Hint/Ord Member-Name Bound-To\n`).join('\n');

test('a cgo DLL that needs a MinGW runtime DLL is refused, the Windows and UCRT ones pass', () => {
  assert.deepEqual(mingwRuntimeImports(imports(['KERNEL32.dll', 'api-ms-win-crt-heap-l1-1-0.dll', 'api-ms-win-crt-runtime-l1-1-0.dll'])), []);
  assert.deepEqual(mingwRuntimeImports(imports(['KERNEL32.dll', 'libwinpthread-1.dll', 'LIBGCC_S_SEH-1.DLL'])), ['libwinpthread-1.dll', 'LIBGCC_S_SEH-1.DLL']);
});

test('objdump output with no imports is an error, not a pass', () => {
  assert.throws(() => mingwRuntimeImports('fzt.dll:     file format pei-x86-64\n'), /no imports/);
});
