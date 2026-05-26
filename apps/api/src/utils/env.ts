import { z } from "zod";

const parsed = z
  .object({
    JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
    PORT: z.coerce.number().default(8080),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
  })
  .safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
