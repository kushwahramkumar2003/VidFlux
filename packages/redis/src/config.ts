export const config = {
  REDIS_URL:
    process.env.REDIS_URL || process.env.REDIS_URI || "redis://localhost:6379",
};
