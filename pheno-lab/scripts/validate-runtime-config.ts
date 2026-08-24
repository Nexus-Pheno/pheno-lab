import { parseServerConfig } from "../src/infrastructure/config/schema";

parseServerConfig(process.env);
console.log("Runtime configuration is valid.");
