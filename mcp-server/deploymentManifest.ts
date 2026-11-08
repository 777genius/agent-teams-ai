interface McpManifestSource {
  name: string;
  version: string;
  engines: Record<string, string>;
}

/** The distributed server bundles its dependencies into index.js. */
export function createMcpDeploymentManifest(source: McpManifestSource) {
  return {
    name: source.name,
    version: source.version,
    private: true,
    type: 'module',
    main: 'index.js',
    files: ['index.js', 'copyHandoff.js'],
    engines: source.engines,
  };
}
