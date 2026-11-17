// Temporary exceptions for HIGH advisories that have NO published fix.
//
// The audit gate normally accepts a HIGH/CRITICAL advisory only with an
// independently verified local backport (transitive-security.ts). An entry here
// is the single, narrower alternative, allowed only while GitHub reports
// first_patched_version as null for the advisory AND every affected install is
// reachable solely from dev/build tooling. Each entry pins the exact advisory,
// package, installed versions per report format and dependency roots, and stops
// working after its hard expiry date, so CI goes red again for a fresh review.
// Remove the entry as soon as a patched version is published.

export const UNPATCHED_EXCEPTIONS = [
  {
    advisory: 'GHSA-fc5q-39xc-vjpf',
    name: 'picomatch',
    // Inclusive, UTC. From 2026-12-16 the advisory blocks CI again.
    validThrough: '2026-12-15',
    reason:
      'picomatch <=4.0.7 ReDoS (CVE-2026-112366). GitHub reports no patched version ' +
      '(first_patched_version null, updated 2026-11-17) and npm has no release after 4.0.7. ' +
      'Upstream fixes are unmerged: micromatch/picomatch#194 and #257-#263. Every affected ' +
      'install is reachable only from build, lint, test and packaging tools; the packaged ' +
      'Electron app ships no node_modules and the landing site is generated statically. ' +
      'Remove this exception when a patched picomatch version exists.',
    // Root workspace pnpm report: findings carry versions and full dependency paths.
    // A root is "<importer>><direct dependency>", the first two path segments.
    pnpm: {
      versions: ['2.3.2', '4.0.4'],
      roots: [
        '.>@electron/rebuild',
        '.>@file-viewer/vite-plugin',
        '.>@tailwindcss/typography',
        '.>@vitejs/plugin-react',
        '.>@vitest/coverage-v8',
        '.>electron-builder',
        '.>electron-vite',
        '.>eslint-import-resolver-typescript',
        '.>eslint-plugin-boundaries',
        '.>eslint-plugin-import',
        '.>eslint-plugin-tailwindcss',
        '.>knip',
        '.>lint-staged',
        '.>tailwindcss',
        // A runtime dependency by declaration, but only required from
        // tailwind.config.js during the renderer build.
        '.>tailwindcss-animate',
        '.>typescript-eslint',
        '.>vite',
        '.>vitest',
        'landing>@nuxtjs/i18n',
        'landing>@vueuse/nuxt',
        'landing>nuxt',
        'landing>tailwindcss',
      ],
    },
    // Standalone landing npm lockfile: versions come from package-lock.json,
    // roots are the landing direct dependencies that reach an affected install.
    npm: {
      versions: ['2.3.2', '4.0.7'],
      // Nuxt modules, the Nuxt/Vite/VitePress toolchain, Tailwind and Sass. The
      // site is generated statically (nuxt generate, vitepress build).
      roots: [
        '@nuxt/eslint',
        '@nuxtjs/i18n',
        '@pinia/nuxt',
        '@vueuse/nuxt',
        'nuxt',
        'nuxt-icon',
        'sass',
        'tailwindcss',
        'vite',
        'vite-plugin-vuetify',
        'vitepress',
      ],
    },
  },
];

const DAY_END = 'T23:59:59.999Z';

export function unpatchedExpired(spec, now) {
  return now > Date.parse(`${spec.validThrough}${DAY_END}`);
}

export function expiryMessage(spec) {
  return (
    `Temporary exception for ${spec.advisory} (${spec.name}) expired after ` +
    `${spec.validThrough}. Check for a patched ${spec.name} release and upgrade, or ` +
    `review the exposure again before extending it. ${spec.reason}`
  );
}

// pnpm entries carry one advisory with findings { version, paths }.
export function pnpmEntryAllowed(spec, entry) {
  const findings = entry.findings;
  if (entry.module_name !== spec.name || !Array.isArray(findings) || findings.length === 0) {
    return false;
  }
  return findings.every(
    (finding) =>
      spec.pnpm.versions.includes(finding.version) &&
      Array.isArray(finding.paths) &&
      finding.paths.length > 0 &&
      finding.paths.every((path) => {
        if (typeof path !== 'string') return false;
        const segments = path.split('>');
        return (
          segments.length >= 3 &&
          segments.at(-1) === spec.name &&
          spec.pnpm.roots.includes(segments.slice(0, 2).join('>'))
        );
      })
  );
}

// npm reports list install paths (nodes) without versions or dependency chains,
// so both come from the lockfile: every affected install must have an allowed
// version and be reachable only from allowed direct dependencies.
export function npmInstallsAllowed(spec, nodes, installs) {
  if (!Array.isArray(nodes) || nodes.length === 0) return false;
  return nodes.every((node) => {
    const install = installs.get(node);
    return (
      install !== undefined &&
      node.endsWith(`node_modules/${spec.name}`) &&
      spec.npm.versions.includes(install.version) &&
      install.roots.length > 0 &&
      install.roots.every((root) => spec.npm.roots.includes(root))
    );
  });
}

// Dependency edges: regular, optional and required peer dependencies. An
// optional peer (peerDependenciesMeta optional) is an opt-in integration that
// npm does not install for the package, so it is not an edge; the peer is
// still checked from the root if the project depends on it directly.
const dependencyNames = (entry) => [
  ...Object.keys(entry.dependencies ?? {}),
  ...Object.keys(entry.optionalDependencies ?? {}),
  ...Object.keys(entry.peerDependencies ?? {}).filter(
    (name) => entry.peerDependenciesMeta?.[name]?.optional !== true
  ),
];

// Resolves an npm v3 lockfile with Node's lookup rule (nearest node_modules,
// then each parent) and maps every install path to its version and to the root
// direct dependencies that reach it.
export function npmLockfileInstalls(lockfile) {
  const packages = lockfile?.packages;
  if (lockfile?.lockfileVersion !== 3 || packages === null || typeof packages !== 'object') {
    throw new Error('Unsupported npm lockfile: expected lockfileVersion 3 with packages');
  }
  const resolveFrom = (from, name) => {
    let base = from;
    for (;;) {
      const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
      if (Object.hasOwn(packages, candidate)) return candidate;
      if (!base) return undefined;
      const index = base.lastIndexOf('/node_modules/');
      base = index === -1 ? '' : base.slice(0, index);
    }
  };
  const root = packages[''] ?? {};
  const installs = new Map();
  const direct = new Set(
    ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((field) =>
      Object.keys(root[field] ?? {})
    )
  );
  for (const name of [...direct].sort()) {
    const start = resolveFrom('', name);
    if (!start) continue;
    const queue = [start];
    const seen = new Set(queue);
    while (queue.length) {
      const path = queue.shift();
      const entry = packages[path];
      const install = installs.get(path) ?? { version: entry.version, roots: [] };
      if (!install.roots.includes(name)) install.roots.push(name);
      installs.set(path, install);
      for (const dependency of dependencyNames(entry)) {
        const next = resolveFrom(path, dependency);
        if (next && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  return installs;
}
