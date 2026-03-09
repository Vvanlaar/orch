export default {
  app: {
    name: "Orch",
    identifier: "dev.orch.desktop",
    version: "0.1.1",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    copy: {
      "../dist/dashboard": "dashboard",
    },
  },
};
