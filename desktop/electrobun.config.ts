import type { ElectrobunConfig } from "electrobun/config";

const config: ElectrobunConfig = {
  name: "Orch",
  identifier: "dev.orch.desktop",
  entry: "src/main.ts",
  icon: "../src/dashboard/public/icons/icon-512.png",
  copy: [
    { from: "../dist", to: "dist" },
    { from: "../.env", to: ".env" },
  ],
};

export default config;
