import test from 'node:test';
import assert from 'node:assert/strict';
import {entryProjects} from '../dotnet/build.mjs';

test('a .NET release publishes the projects that are neither tests nor referenced', () => {
  const files = {
    'SpireLens.csproj': '<Project><ItemGroup><ProjectReference Include="Core/SpireLens.Core.csproj" ReferenceOutputAssembly="false" /></ItemGroup></Project>',
    'Core/SpireLens.Core.csproj': '<Project></Project>',
    'Tests/SpireLens.Core.Tests/SpireLens.Core.Tests.csproj': '<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17" /><ProjectReference Include="../../Core/SpireLens.Core.csproj" /></ItemGroup></Project>',
    'README.md': '',
  };
  assert.deepEqual(entryProjects(Object.keys(files), file => files[file]), ['SpireLens.csproj']);
});
