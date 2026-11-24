// Stdio entry: node --no-warnings=ExperimentalWarning packages/mcp/src/main.ts [--demo]
import { runMcpServer } from "./mcp.ts";

await runMcpServer({ demo: process.argv.includes("--demo") || process.env.IRIS_DEMO === "1" });
