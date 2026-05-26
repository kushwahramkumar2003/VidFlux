import z from "zod";

export const newRawVideoSchema = z.object({
  url: z.url().min(1, "URL is required"),
});
