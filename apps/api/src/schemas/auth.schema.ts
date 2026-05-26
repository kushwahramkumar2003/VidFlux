import { z } from "zod";

export const signupSchema = z.object({
  name: z.string().min(3, "Name must be atleast 3 chars."),
  password: z.string().min(8, "Password must be at least 8 chars"),
  email: z.email(),
});

export const loginSchema = z.object({
  password: z.string().min(8, "Invalid password!"),
  email: z.email("Invalid email address"),
});
