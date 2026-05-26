import type { Request, Response } from "express";
import { asyncHandler } from "../services/asyncHandler";
import { loginSchema, signupSchema } from "../schemas/auth.schema";
import bcrypt from "bcrypt";
import { appResponse } from "../services/appResponse";
import { prisma } from "@repo/db";
import { AppError } from "../services/appError";
import jwt from "jsonwebtoken";
import { env } from "../utils/env";
import { cookieConfig } from "../utils/config";

export const signup = asyncHandler(async (req: Request, res: Response) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    throw parsed.error;
  }
  const hashedPwd = await bcrypt.hash(parsed.data.password, 10);
  const user = await prisma.user.create({
    data: {
      name: parsed.data.name,
      email: parsed.data.email,
      password: hashedPwd,
    },
    select: {
      email: true,
      id: true,
      name: true,
    },
  });

  return appResponse({ res, data: user, message: "User created successfully" });
});

export const login = asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    throw parsed.error;
  }

  const user = await prisma.user.findFirst({
    where: {
      email: parsed.data.email,
    },
  });

  const isValid = await bcrypt.compare(
    parsed.data.password,
    user?.password ?? ""
  );
  if (!isValid) {
    throw new AppError("Invalid email or password");
  }
  const token = jwt.sign({ id: user?.id }, env.JWT_SECRET);
  res.cookie("token", token, cookieConfig);

  return appResponse({ res, message: "Logged success" });
});
