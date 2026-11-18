// A repository's CI selections are its Forgejo topics (PIPT-12): the Fleet workflow applies
// them from fleet.json. Topics starting `ci-` are the Forgejo patch's suites, not settings.
const testTools = ['go', 'rust', 'cmake', 'dotnet', 'python'];
export const releaseToolchains = ['go', 'rust', 'npm', 'python', 'dotnet', 'cmake', 'powershell'];
export const rustBuilds = {
  'windows-amd64': 'x86_64-pc-windows-msvc', 'windows-arm64': 'aarch64-pc-windows-msvc',
  'linux-amd64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
};
const lints = ['typos', 'machete', 'audit'];
const serviceNames = ['postgres', 'manticore', 'greenmail'];

// Every setting topic, and so every topic Fleet owns besides `ci-`.
export const settingTopics = [
  ...testTools.flatMap(tool => [`${tool}-test-linux`, `${tool}-test-windows`]),
  'go-race', ...lints.map(lint => `rust-${lint}`), 'windows-powershell',
  ...serviceNames.map(name => `service-${name}`),
  'cluster-image', 'web-image', 'web-static', 'web-history',
  'release-source', 'release-module', ...releaseToolchains.map(kind => `release-${kind}`),
  'version-from-manifest', 'version-four-part', 'home-sync',
  ...Object.keys(rustBuilds).map(platform => `rust-build-${platform}`),
  'release-archive', 'release-source-list', 'release-external',
];
const known = new Set(settingTopics);
export const isSettingTopic = topic => known.has(topic);
// What Forgejo accepts as a topic.
export const validTopic = topic => typeof topic === 'string' && /^[a-z0-9][-.a-z0-9]*$/.test(topic) && topic.length <= 35;
