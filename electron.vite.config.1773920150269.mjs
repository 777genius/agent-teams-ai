// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
import { resolve } from "path";
var __electron_vite_injected_dirname = "/Users/belief/dev/projects/claude/claude_team";
var pkg = JSON.parse(readFileSync(resolve(__electron_vite_injected_dirname, "package.json"), "utf-8"));
var prodDeps = Object.keys(pkg.dependencies || {});
var bundledDeps = prodDeps.filter((d) => d !== "node-pty" && d !== "agent-teams-controller");
function nativeModuleStub() {
  const STUB_ID = "\0native-stub";
  return {
    name: "native-module-stub",
    resolveId(source) {
      if (source.endsWith(".node")) return STUB_ID;
      return null;
    },
    load(id) {
      if (id === STUB_ID) return "export default {}";
      return null;
    }
  };
}
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: bundledDeps
      }),
      nativeModuleStub()
    ],
    resolve: {
      alias: {
        "@main": resolve(__electron_vite_injected_dirname, "src/main"),
        "@shared": resolve(__electron_vite_injected_dirname, "src/shared"),
        "@preload": resolve(__electron_vite_injected_dirname, "src/preload")
      }
    },
    build: {
      outDir: "dist-electron/main",
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/main/index.ts"),
          "team-fs-worker": resolve(__electron_vite_injected_dirname, "src/main/workers/team-fs-worker.ts")
        },
        output: {
          // CJS format so bundled deps can use __dirname/require.
          // Use .cjs extension since package.json has "type": "module".
          format: "cjs",
          entryFileNames: "[name].cjs",
          // Set UV_THREADPOOL_SIZE before any module code runs.
          // Must be in the banner because ESM→CJS hoists imports above top-level code.
          // On Windows, fs.watch({recursive:true}) occupies a UV pool thread per watcher;
          // with 3+ watchers + concurrent fs/DNS/spawn, the default 4 threads deadlock.
          banner: `if(!process.env.UV_THREADPOOL_SIZE){process.env.UV_THREADPOOL_SIZE='24'}`
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@preload": resolve(__electron_vite_injected_dirname, "src/preload"),
        "@shared": resolve(__electron_vite_injected_dirname, "src/shared"),
        "@main": resolve(__electron_vite_injected_dirname, "src/main")
      }
    },
    build: {
      outDir: "dist-electron/preload",
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/preload/index.ts")
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].js"
        }
      }
    }
  },
  renderer: {
    optimizeDeps: {
      include: ["@codemirror/language-data"]
    },
    resolve: {
      alias: {
        "@renderer": resolve(__electron_vite_injected_dirname, "src/renderer"),
        "@shared": resolve(__electron_vite_injected_dirname, "src/shared"),
        "@main": resolve(__electron_vite_injected_dirname, "src/main")
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/renderer/index.html")
        }
      }
    }
  }
});
export {
  electron_vite_config_default as default
};
