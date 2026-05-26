import { createClient, type RedisClientType } from "redis";
import { config } from "./config";

let redisConn: RedisClientType | null = null;
let lastRedisErrorLogAt = 0;
const REDIS_ERROR_LOG_THROTTLE_MS = 15_000;

export function getRedisConnection(): RedisClientType {
  if (redisConn) return redisConn;
  if (!config.REDIS_URL) {
    throw new Error("REDIS_URL is not configured");
  }
  console.log("Connecting to:", config.REDIS_URL);

  const isTLS =
    config.REDIS_URL.includes("cloud.redislabs.com") ||
    config.REDIS_URL.startsWith("rediss://");

  redisConn = createClient({
    url: config.REDIS_URL,
    socket: {
      connectTimeout: 10_000,
      reconnectStrategy: (attempt) => {
        console.log(`Retry attempt #${attempt}`);
        return Math.min(attempt * 500, 5000);
      },
      ...(isTLS ? { tls: true, rejectUnauthorized: false } : {}),
    },
  });

  redisConn.on("connect", () => console.log("TCP connected"));
  redisConn.on("ready", () => console.log("Ready to use"));
  redisConn.on("close", () => console.log("Connection closed"));
  redisConn.on("reconnecting", () => console.log("Reconnecting..."));
  redisConn.on("end", () => console.log("Connection ended"));

  redisConn.on("error", (error) => {
    const now = Date.now();
    if (now - lastRedisErrorLogAt >= REDIS_ERROR_LOG_THROTTLE_MS) {
      console.log("Error:", error.message);
      lastRedisErrorLogAt = now;
    }
  });

  void redisConn.connect();

  return redisConn;
}
